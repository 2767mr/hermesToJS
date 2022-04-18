import * as ts from 'typescript';
import { Disassembler, Instruction, Operand } from './disasm';
import { FunctionHeader, HBCHeader } from './parser';

enum BlockType {
	DEFAULT,
	JUMP,
	IF,
	LOOP,
}

interface Block {
	type: BlockType;
	insts: Instruction[];
	tLabel: Block;
	fLabel: Block;
}

interface InstructionNode {
	instr: Instruction;
	inline?: true;
}

interface Environment {
	parent: Environment;
	variables: ts.Identifier[];
}

interface Context {
	environment: Environment;
	nodeConversion: Map<InstructionNode, ts.Node>;
	blocksConversion: Map<Block, ts.Statement[]>;
	fixups: Map<ts.Node, () => ts.Statement[]>;
	environments: Map<ts.Expression, Environment>;
	params: ts.Identifier[];
	registers: ts.Identifier[];
}


export class Decompiler {
	private sourceFile!: ts.SourceFile;
	private readonly printer = ts.createPrinter();

	public constructor(
		private readonly disasm: Disassembler,
		private readonly header: HBCHeader,
	) { }

	public decompile(outfile: string) {
		this.sourceFile = this.createSourcefile(outfile, [], ts.ScriptTarget.Latest);

		const context: Context = {
			environment: {} as Environment,
			blocksConversion: new Map(),
			nodeConversion: new Map(),
			fixups: new Map(),
			environments: new Map(),
			params: [ts.factory.createIdentifier('p' + (this.nextID++))],
			registers: [],
		};
		const result = this.decompileFuction(this.header.functionHeaders[0], context);

		return ts.factory.updateSourceFile(this.sourceFile, Array.from(result.statements));
	}
	private asOffset(operand: Operand, ip: number) {
		if ((operand.type !== 'Addr8' && operand.type !== 'Addr32') || typeof operand.value !== 'number') {
			throw new Error(`Invalid number: ${operand}`);
		}
		return operand.value + ip;
	}

	private decompileFuction(fHeader: FunctionHeader, context: Context): ts.Block {
		context.environment.parent = context.environment;
		const insts = this.disasm.disassemble(fHeader);
		const labels = this.labels(insts);
		const blocks = this.blocks(insts, labels);
		const flow = this.blockFlow(blocks);


		const stmts = this.convertBlock(flow, context);
		const withRegs = this.buildRegisters(context, stmts);
		const block = ts.factory.createBlock(withRegs, true);
		const fixed = this.applyFixups(block, context);
		const blockWhile = this.combineIfDoWhile(fixed);
		return blockWhile;
	}

	private convertBlock(block: Block, context: Context, until?: Block) {
		if (context.blocksConversion.has(block)) {
			return context.blocksConversion.get(block) as ts.Statement[];
		}

		let stmts: ts.Statement[] = [];		
		context.blocksConversion.set(block, stmts);

		for (const instr of block.insts) {
			const node: InstructionNode = {instr};
			if (node.instr.opcode === 'CreateEnvironment') {
				const expr = this.emit(node, context);
				const fixup = context.fixups.get(expr)!;
				context.fixups.delete(expr);
				const dummy = ts.factory.createEmptyStatement();
				stmts.push(dummy);
				context.fixups.set(dummy, fixup);
			} else {
				const tsNode = this.emit(node, context);

				if (node.instr.opcode === 'Jmp' || node.instr.opcode === 'JmpLong') {
					if (until != block.tLabel) {
						stmts.push(...this.convertBlock(block.tLabel, context, until));
					}
					return stmts;
				}

				if (node.instr.opcode.startsWith('J')) {
					const expr = tsNode as ts.Expression;
					if (node.instr.operands[0].value < 0) {
						stmts = [
							ts.factory.createDoStatement(
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, block), true),
								expr
							)
						];
						context.blocksConversion.set(block, stmts);
					} else if (node.instr.opcode.includes('Not')) {
						if (!block.tLabel) { //TODO: This is invalid
							return [ts.factory.createThrowStatement(ts.factory.createStringLiteral('Decompiler error'))];
						}
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, jmp.tLabel), true),
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, jmp.tLabel), true)));
							stmts.push(...this.convertBlock(jmp.tLabel, context, until));
						} else {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, block.tLabel), true)));
							stmts.push(...this.convertBlock(block.tLabel, context, until));
						}
					} else {
						if (!block.tLabel) { //TODO: This is invalid
							return [ts.factory.createThrowStatement(ts.factory.createStringLiteral('Decompiler error'))];
						}
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, jmp.tLabel), true),
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, jmp.tLabel), true)));
							stmts.push(...this.convertBlock(jmp.tLabel, context, until));
						} else {
							stmts.push(ts.factory.createIfStatement(ts.factory.createLogicalNot(expr),
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, block.tLabel), true)));
							stmts.push(...this.convertBlock(block.tLabel, context, until));
						}
					}
				} else if (!ts.isVoidExpression(tsNode)) {
					if (ts.isReturnStatement(tsNode) || ts.isEmptyStatement(tsNode)) {
						stmts.push(tsNode);
					} else {
						stmts.push(ts.factory.createExpressionStatement(tsNode as ts.Expression));
					}
				}
			}
		}

		if (!block.insts[block.insts.length - 1].opcode.startsWith('J') 
		&& until != block.fLabel
		&& block.insts[block.insts.length - 1].opcode !== 'Ret') {
			stmts.push(...this.convertBlock(block.fLabel, context, until));
		}

		return stmts;
	}

	private emit(node: InstructionNode, context: Context) {
		const r = this.convertInstruction(node, context);
		context.nodeConversion.set(node, r);
		return r;
	}

	private endsInJmp(block: Block, visited: Set<Block>, ip: number): Block | undefined {
		if (visited.has(block)) {
			return;
		}
		visited.add(block);

		if (!block) { //TODO: This should never happen
			return;
		}

		if (block.insts[block.insts.length - 1].opcode === 'Jmp' && block.fLabel.insts[0].ip === ip) {
			return block;
		}

		if (block.insts.some(i => i.opcode === 'Ret')) {
			return;
		}

		const resultT = this.endsInJmp(block.tLabel, visited, ip);
		if (resultT) {
			return resultT;
		}

		if (block.insts[block.insts.length - 1].opcode === 'Jmp') {
			return this.endsInJmp(block.fLabel, visited, ip);
		}
	}

	private convertInstruction(node: InstructionNode, ctx: Context) : ts.Node {
		if (ctx.nodeConversion.has(node)) {
			return ctx.nodeConversion.get(node)!;
		}

		let left: ts.Expression;

		switch (node.instr.opcode) {
		case 'LoadConstString':
		case 'LoadConstStringLongIndex': //TODO: check
			return this.assign(ctx, node, 0, 
				ts.factory.createStringLiteral(node.instr.operands[1].value as string));
		case 'LoadConstZero':
			return this.assign(ctx, node, 0, 
				ts.factory.createNumericLiteral(0));
		case 'LoadConstUndefined':
			return this.assign(ctx, node, 0, 
				ts.factory.createIdentifier('undefined'));
		case 'LoadConstNull':
			return this.assign(ctx, node, 0, 
				ts.factory.createNull());
		case 'LoadConstFalse':
			return this.assign(ctx, node, 0, 
				ts.factory.createFalse());
		case 'LoadConstTrue':
			return this.assign(ctx, node, 0, 
				ts.factory.createTrue());
		case 'LoadConstUInt8':
		case 'LoadConstInt':
		case 'LoadConstDouble':
			return this.assign(ctx, node, 0, 
				ts.factory.createNumericLiteral(node.instr.operands[1].value as number));
		case 'LoadParam':
			return this.assign(ctx, node, 0, 
				ctx.params[node.instr.operands[1].value as number]);
		case 'NewObject':
			return this.assign(ctx, node, 0, 
				ts.factory.createObjectLiteralExpression());
		case 'GetGlobalObject':
			return this.assign(ctx, node, 0, 
				ts.factory.createIdentifier('globalThis'));
		case 'TypeOf':
			return this.assign(ctx, node, 0, 
				ts.factory.createTypeOfExpression(this.toIdentifier(ctx, node, 1)));
		case 'JmpTrue':
		case 'JmpTrueLong': //TODO: check
			return this.toIdentifier(ctx, node, 1); //TODO: check
		case 'JmpFalse':
		case 'JmpFalseLong': //TODO: check
			return ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, this.toIdentifier(ctx, node, 1)); //TODO: check
		case 'JLess':
		case 'JLessN': //TODO: check
		case 'JLessLong': //TODO: check
		case 'JLessNLong': //TODO: check
		case 'JNotLess':
		case 'JNotLessN': //TODO: check
		case 'JNotLessLong': //TODO: check
		case 'JNotLessNLong': //TODO: check
			return ts.factory.createLessThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JLessEqual':
		case 'JLessEqualN': //TODO: check
		case 'JLessEqualLong': //TODO: check
		case 'JLessEqualNLong': //TODO: check
		case 'JNotLessEqual':
		case 'JNotLessEqualN': //TODO: check
		case 'JNotLessEqualLong': //TODO: check
		case 'JNotLessEqualNLong': //TODO: check
			return ts.factory.createLessThanEquals(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JGreater':
		case 'JGreaterN': //TODO: check
		case 'JGreaterNLong': //TODO: check
		case 'JGreaterLong': //TODO: check
		case 'JNotGreater':
		case 'JNotGreaterN': //TODO: check
		case 'JNotGreaterLong': //TODO: check
		case 'JNotGreaterNLong': //TODO: check
			return ts.factory.createGreaterThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JGreaterEqual':
		case 'JGreaterEqualN': //TODO: check
		case 'JGreaterEqualNLong': //TODO: check
		case 'JGreaterEqualLong': //TODO: check
		case 'JNotGreaterEqual':
		case 'JNotGreaterEqualN': //TODO: check
		case 'JNotGreaterEqualLong': //TODO: check
		case 'JNotGreaterEqualNLong': //TODO: check
			return ts.factory.createGreaterThanEquals(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JEqual':
		case 'JEqualLong': //TODO: check
		case 'JNotEqual':
		case 'JNotEqualLong': //TODO: check
			return ts.factory.createEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JStrictEqual':
		case 'JStrictEqualLong': //TODO: check
			return ts.factory.createStrictEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JStrictNotEqual':
		case 'JStrictNotEqualLong': //TODO: check
			return ts.factory.createStrictEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JmpUndefined':
		case 'JmpUndefinedLong': //TODO: check
			return ts.factory.createEquality(this.toIdentifier(ctx, node, 1), ts.factory.createIdentifier('undefined'));
		case 'TryGetById':
			left = this.toIdentifier(ctx, node, 1);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return this.assign(ctx, node, 0, 
					ts.factory.createIdentifier(node.instr.operands[3].value as string));
			}

			return this.assign(ctx, node, 0, 
				ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string));
		case 'GetById':
			left = this.toIdentifier(ctx, node, 1);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return this.assign(ctx, node, 0, 
					ts.factory.createIdentifier(node.instr.operands[3].value as string));
			}

			return ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string);
		case 'GetByIdShort':
			left = this.toIdentifier(ctx, node, 1);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return this.assign(ctx, node, 0, 
					ts.factory.createIdentifier(node.instr.operands[3].value as string));
			}

			return this.assign(ctx, node, 0, 
				ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string));
		case 'Call':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.toIdentifier(ctx, node, 1), 'call'), 
					undefined, 
					[])); //TODO: arguments
		case 'Call1':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.toIdentifier(ctx, node, 1), 'call'), 
					undefined, 
					[this.toIdentifier(ctx, node, 2)]));
		case 'Call2':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.toIdentifier(ctx, node, 1), 'call'), 
					undefined, 
					[this.toIdentifier(ctx, node, 2), this.toIdentifier(ctx, node, 3)]));
		case 'Call3':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.toIdentifier(ctx, node, 1), 'call'), 
					undefined, 
					[
						this.toIdentifier(ctx, node, 2), 
						this.toIdentifier(ctx, node, 3), 
						this.toIdentifier(ctx, node, 4)]));
		case 'Call4':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.toIdentifier(ctx, node, 1), 'call'), 
					undefined, 
					[
						this.toIdentifier(ctx, node, 2), 
						this.toIdentifier(ctx, node, 3), 
						this.toIdentifier(ctx, node, 4), 
						this.toIdentifier(ctx, node, 5)]));
		case 'AddN':
			return this.assign(ctx, node, 0, 
				ts.factory.createAdd(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Add':
			return this.assign(ctx, node, 0, 
				ts.factory.createAdd(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'SubN':
			return this.assign(ctx, node, 0, 
				ts.factory.createSubtract(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Sub':
			return this.assign(ctx, node, 0, 
				ts.factory.createSubtract(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'MulN':
			return this.assign(ctx, node, 0, 
				ts.factory.createMultiply(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Mul':
			return this.assign(ctx, node, 0, 
				ts.factory.createMultiply(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'DivN':
			return this.assign(ctx, node, 0, 
				ts.factory.createDivide(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Div':
			return this.assign(ctx, node, 0, 
				ts.factory.createDivide(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Mod':
			return this.assign(ctx, node, 0, 
				ts.factory.createModulo(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'URshift':
			return this.assign(ctx, node, 0, 
				ts.factory.createUnsignedRightShift(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'LShift':
			return this.assign(ctx, node, 0, 
				ts.factory.createLeftShift(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'RShift':
			return this.assign(ctx, node, 0, 
				ts.factory.createRightShift(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'BitAnd':
			return this.assign(ctx, node, 0, 
				ts.factory.createBitwiseAnd(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'BitOr':
			return this.assign(ctx, node, 0, 
				ts.factory.createBitwiseOr(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'BitXor':
			return this.assign(ctx, node, 0, 
				ts.factory.createBitwiseXor(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'StrictEq':
			return this.assign(ctx, node, 0, 
				ts.factory.createStrictEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'StrictNeq':
			return this.assign(ctx, node, 0, 
				ts.factory.createStrictInequality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Eq':
			return this.assign(ctx, node, 0, 
				ts.factory.createEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Neq':
			return this.assign(ctx, node, 0, 
				ts.factory.createInequality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Greater':
			return this.assign(ctx, node, 0, 
				ts.factory.createGreaterThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'GreaterEq':
			return this.assign(ctx, node, 0, 
				ts.factory.createGreaterThanEquals(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Less':
			return this.assign(ctx, node, 0, 
				ts.factory.createLessThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'LessEq':
			return this.assign(ctx, node, 0, 
				ts.factory.createLessThanEquals(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Not':
			return this.assign(ctx, node, 0, 
				ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.ExclamationToken, this.toIdentifier(ctx, node, 1)));
		case 'BitNot':
			return this.assign(ctx, node, 0, 
				ts.factory.createPrefixUnaryExpression(ts.SyntaxKind.TildeToken, this.toIdentifier(ctx, node, 1)));
		case 'Jmp':
		case 'JmpLong': //TODO: check
			return ts.factory.createVoidZero();
		case 'Ret':
			left = this.toIdentifier(ctx, node, 0);
			return ts.factory.createReturnStatement(left) as unknown as ts.Expression;
		case 'Mov':
		case 'MovLong': //TODO: check
			return this.assign(ctx, node, 0, 
				this.toIdentifier(ctx, node, 1));
		case 'LoadThisNS':
			return this.assign(ctx, node, 0, 
				ts.factory.createThis());
		case 'DeclareGlobalVar':
			return ts.factory.createVoidZero();
		case 'CreateEnvironment': {
			const dummyExpression = ts.factory.createVoidZero();
			const env: Environment = {
				parent: ctx.environment,
				variables: []
			};
			ctx.fixups.set(dummyExpression, () => env.variables.map(
				v => v ? ts.factory.createVariableStatement(undefined, [
					ts.factory.createVariableDeclaration(v)
				]) : ts.factory.createEmptyStatement()
			));
			ctx.environments.set(this.toIdentifier(ctx, node, 0), env);
			return dummyExpression;
		}
		case 'GetEnvironment': {
			const count = node.instr.operands[1].value as number;
			let result = ctx.environment;
			for (let i = 0; i < count; i++) {
				result = result.parent;
			}
			
			ctx.environments.set(this.toIdentifier(ctx, node, 0), result);
			return ts.factory.createEmptyStatement();
		}
		case 'StoreToEnvironment':
		case 'StoreNPToEnvironment': //TODO: 
		case 'StoreToEnvironmentL': //TODO: 
		case 'StoreNPToEnvironmentL': //TODO: 
		{
			const dummyExpression = this.toIdentifier(ctx, node, 0);
			const index = node.instr.operands[1].value as number;
			const value = this.toIdentifier(ctx, node, 2);

			const env = ctx.environments.get(dummyExpression);
			if (!env) {
				throw new Error('Invalid environment in StoreToEnvironment arg 0');
			}

			const ident = this.getEnvVariable(env, index);

			return ts.factory.createAssignment(ident, value); 
		}
		case 'LoadFromEnvironment':
		case 'LoadFromEnvironmentL':
		{
			const dummyExpression = this.toIdentifier(ctx, node, 1);
			const index = node.instr.operands[2].value as number;

			const env = ctx.environments.get(dummyExpression);
			if (!env) {
				throw new Error('Invalid environment in LoadFromEnvironment arg 1');
			}

			return this.assign(ctx, node, 0, this.getEnvVariable(env, index)); 
		}
		case 'PutById':
			left = this.toIdentifier(ctx, node, 0);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return ts.factory.createAssignment(
					ts.factory.createIdentifier(node.instr.operands[3].value as string), 
					this.toIdentifier(ctx, node, 1));
			}

			return ts.factory.createAssignment(
				ts.factory.createPropertyAccessExpression(
					left,
					node.instr.operands[3].value as string
				), this.toIdentifier(ctx, node, 1));
		case 'CreateClosure':
			left = this.toIdentifier(ctx, node, 1);
			return this.assign(ctx, node, 0, this.createClosure(left, node.instr.operands[2].value as number, ctx));
		case 'ToNumber':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(ts.factory.createIdentifier('Number'), undefined, [this.toIdentifier(ctx, node, 1)]));
		case 'CallBuiltin':
			//TODO
			return ts.factory.createCallExpression(ts.factory.createIdentifier(node.instr.operands[1].value as string), undefined, []);
		case 'NewObjectWithBuffer':
		case 'NewObjectWithBufferLong':
		{
			//const preallocationSizeHint = node.instr.operands[1].value as number;
			const staticElements = node.instr.operands[2].value as number;
			const keyIndex = node.instr.operands[3].value as number;
			const valueIndex = node.instr.operands[4].value as number;

			const properties: ts.ObjectLiteralElementLike[] = [];
			for (let i = 0; i < staticElements; i++) {
				properties.push(ts.factory.createPropertyAssignment('' + this.header.objKeyValues[keyIndex + i], 
					this.toLiteral(this.header.objValueValues[valueIndex + i])));
			}

			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createObjectLiteralExpression(properties, staticElements > 1)
			); 
		}
		case 'NewArrayWithBuffer':
		case 'NewArrayWithBufferLong':
		{
			//const preallocationSizeHint = node.instr.operands[1].value as number;
			const staticElements = node.instr.operands[2].value as number;
			const index = node.instr.operands[3].value as number;

			const elements: ts.Expression[] = [];
			for (let i = 0; i < staticElements; i++) {
				elements.push(this.toLiteral(this.header.arrayValues[index + i]));
			}

			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createArrayLiteralExpression(elements)
			);
		}
		case 'NewArray':
			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createArrayLiteralExpression()
			);
		case 'PutOwnByIndex':
			return ts.factory.createAssignment(
				ts.factory.createElementAccessExpression(
					this.toIdentifier(ctx, node, 0),
					node.instr.operands[2].value as number
				),
				this.toIdentifier(ctx, node, 1),
			);
		case 'PutByVal':
			return ts.factory.createAssignment(
				ts.factory.createElementAccessExpression(
					this.toIdentifier(ctx, node, 0),
					this.toIdentifier(ctx, node, 1)
				),
				this.toIdentifier(ctx, node, 2),
			);
		case 'GetByVal':
			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createElementAccessExpression(
					this.toIdentifier(ctx, node, 1),
					this.toIdentifier(ctx, node, 2)
				)
			);
		case 'CreateThis':
			return ts.factory.createEmptyStatement(); //TODO: this instruction is followed by mov instructions that pass the arguments for Construct.
		case 'Construct':
			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createNewExpression(this.toIdentifier(ctx, node, 1), undefined, []) //TODO: arguments
			);
		case 'Throw':
			return ts.factory.createEmptyStatement();//TODO: return ts.factory.createThrowStatement(this.toIdentifier(ctx, node, 0));
		case 'AddEmptyString':
			return this.assign(ctx, node, 0, ts.factory.createAdd(ts.factory.createStringLiteral(''), this.toIdentifier(ctx, node, 1)));
		case 'ToInt32':
			return this.assign(ctx, node, 0, ts.factory.createBitwiseOr(this.toIdentifier(ctx, node, 1), ts.factory.createNumericLiteral(0)));
		case 'Negate':
			return this.assign(ctx, node, 0, ts.factory.createPrefixMinus(this.toIdentifier(ctx, node, 1)));
		case 'IsIn':
			return this.assign(ctx, node, 0, 
				ts.factory.createBinaryExpression(
					this.toIdentifier(ctx, node, 1),
					ts.SyntaxKind.InKeyword,
					this.toIdentifier(ctx, node, 2),
				));
		case 'InstanceOf':
			return this.assign(ctx, node, 0, 
				ts.factory.createBinaryExpression(
					this.toIdentifier(ctx, node, 1),
					ts.SyntaxKind.InstanceOfKeyword,
					this.toIdentifier(ctx, node, 2),
				)); //TODO: Figure out "Note that this is not the same as JS instanceof."
		case 'SelectObject':
			return ts.factory.createEmptyStatement(); //TODO: Figure this out
			/*
			return ts.factory.createAssignment(
				this.toIdentifier(ctx, node, 0),
				ts.factory.createConditionalExpression(
					ts.factory.createBinaryExpression(
						this.toIdentifier(ctx, node, 2),
						ts.SyntaxKind.InstanceOfKeyword,
						ts.factory.createIdentifier('Object')
					),
					undefined,
					this.toIdentifier(ctx, node, 2),
					undefined,
					this.toIdentifier(ctx, node, 1)
				)
			);*/
		case 'Catch':
			return ts.factory.createEmptyStatement(); //TODO: 
		case 'GetPNameList':
			return this.assign(ctx, node, 0, ts.factory.createConditionalExpression(
				this.toIdentifier(ctx, node, 1),
				undefined,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						ts.factory.createCallExpression(
							ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Object'), 'keys'), 
							undefined,
							[this.toIdentifier(ctx, node, 1)]),
						'slice'
					),
					undefined,
					[this.toIdentifier(ctx, node, 2)]
				)
				,
				undefined,
				ts.factory.createArrayLiteralExpression()
			)); //TODO:
		case 'GetNextPName':
			return this.assign(ctx, node, 0, ts.factory.createElementAccessExpression(
				this.toIdentifier(ctx, node, 1),
				this.toIdentifier(ctx, node, 2)
			)); //TODO:
		case 'GetArgumentsLength':
			return this.assign(ctx, node, 0, ts.factory.createPropertyAccessExpression(
				ts.factory.createIdentifier('arguments'),
				'length'
			)); //TODO: 
		case 'GetArgumentsPropByVal':
			return this.assign(ctx, node, 0, ts.factory.createElementAccessExpression(
				ts.factory.createIdentifier('arguments'),
				this.toIdentifier(ctx, node, 1)
			)); //TODO: 
		case 'ReifyArguments':
			return this.assign(ctx, node, 0, ts.factory.createIdentifier('arguments')); //TODO: 
		case 'PutNewOwnById':
		case 'PutNewOwnByIdShort':
		case 'PutOwnByIndexL':
		case 'DelById':
		case 'DelByVal':
		case 'PutOwnGetterSetterByVal':
		case 'CreateRegExp':
		case 'SwitchImm':
		case 'NewObjectWithParent':
			return ts.factory.createEmptyStatement(); //TODO: not implemented
		default:
			throw new Error('Opcode conversion not implemented: ' + node.instr.opcode);
		}
	}

	private toLiteral(value: unknown): ts.Expression {
		if (value === null) {
			return ts.factory.createNull();
		}
		if (value === true) {
			return ts.factory.createTrue();
		}
		if (value === false) {
			return ts.factory.createTrue();
		}
		if (typeof value === 'string') {
			return ts.factory.createStringLiteral(value);
		}
		if (typeof value === 'number') {
			return ts.factory.createNumericLiteral(value);
		}
		return ts.factory.createStringLiteral(''); //TODO: remove debug;
		throw new Error('Unknown literal type: ' + typeof value);
	}

	//TODO: remove
	private nextID = 1;
	private toIdentifier(ctx: Context, node: InstructionNode, index: number) {
		const result = ctx.registers[node.instr.operands[index].value as number];
		if (result) {
			return result;
		}

		return ctx.registers[node.instr.operands[index].value as number]
			= ts.factory.createIdentifier('r' + (this.nextID++));
	}

	private assign(ctx: Context, node: InstructionNode, index: number, tsNode: ts.Expression) {
		return ts.factory.createAssignment(this.toIdentifier(ctx, node, index), tsNode as ts.Expression);
	}

	private createClosure(dummy: ts.Expression, funcId: number, context: Context): ts.Expression {
		const env = context.environments.get(dummy);
		if (!env) throw new Error('Unreachable? Could not resolve environment.');

		const func = this.header.functionHeaders[funcId];

		const params: ts.Identifier[] = [];
		for (let i = 0; i < func.paramCount; i++) {
			params.push(ts.factory.createIdentifier('p' + (this.nextID++))); //ts.GeneratedIdentifierFlags.ReservedInNestedScopes
		}

		const childContext: Context = {
			blocksConversion: new Map(),
			environment: env,
			environments: new Map(),
			fixups: new Map(),
			nodeConversion: new Map(),
			params: params,
			registers: [],
		};
		
		const body = this.decompileFuction(func, childContext);

		const result = ts.factory.createFunctionExpression(
			undefined,
			undefined,
			this.disasm.getName(func) || undefined,
			undefined,
			childContext.params.slice(1).map(
				i => ts.factory.createParameterDeclaration(
					undefined, undefined, undefined,
					i,
					undefined, undefined, undefined
				)
			),
			undefined,
			body
		);

		return result;
	}

	private getEnvVariable(env: Environment, index: number) {
		if (env.variables[index]) {
			return env.variables[index];
		}
		
		const ident = ts.factory.createIdentifier('c' + (this.nextID++));
		env.variables[index] = ident;
		return ident;
	}

	private labels(insts: Instruction[]) {
		const labels: number[] = [];
		for (const inst of insts) {
			for (const operand of inst.operands) {
				if (operand.type === 'Addr8' || operand.type === 'Addr32') {
					labels.push(this.asOffset(operand, inst.ip));
				}
			}
		}

		labels.sort((a, b) => a - b);

		return labels;
	}

	private blocks(insts: Instruction[], labels: number[]): Record<number, Instruction[]> {
		const result: Record<number, Instruction[]> = {};

		let block: Instruction[] = [];
		for (const inst of insts) {
			if (block.length > 0 && labels.includes(inst.ip)) {
				result[block[0].ip] = block;
				block = [];
			}
			block.push(inst);
			if (inst.opcode.startsWith('J')) {
				result[block[0].ip] = block;
				block = [];
			}
		}

		if (block.length > 0) {
			result[block[0].ip] = block;
		}

		const resultLength = Object.values(result).map(b => b.length).reduce((a, b) => a + b, 0);
		if (insts.length !== resultLength) {
			throw new Error('Statement count mismatch');
		}

		return result;
	}

	private blockFlow(blocks: Record<number, Instruction[]>): Block {
		const blockMap: Record<number, Block> = {};
		const ipList = Object.keys(blocks).map(ip => Number(ip)).sort((a, b) => a - b);

		for (const ip of ipList) {
			const block: Block = {
				type: BlockType.DEFAULT,
				insts: blocks[ip],
				tLabel: {} as Block,
				fLabel: {} as Block,
			};
			block.tLabel = block;
			block.fLabel = block;
			blockMap[ip] = block;
		}

		for (const ip of ipList) {
			const block = blockMap[ip];
			block.fLabel = blockMap[ipList.find(l => l > ip) ?? ip];
			
			const last = block.insts[block.insts.length - 1];
			const target = last?.operands.find(op => op.type === 'Addr8' || op.type === 'Addr32');
			if (target) {
				const targetIP = this.asOffset(target, last.ip);
				block.tLabel = blockMap[targetIP];
			} else {
				block.tLabel = block.fLabel;
			}			
		}

		return blockMap[0];
	}
	
	private buildRegisters(ctx: Context, stmts: ts.Statement[]) {
		if (ctx.registers.length === 0) {
			return stmts;
		}

		const decl = ts.factory.createVariableStatement(
			undefined,
			ts.factory.createVariableDeclarationList(
				ctx.registers.filter(i => i && ts.isIdentifier(i)).map(
					i => ts.factory.createVariableDeclaration(i)
				),
				ts.NodeFlags.Let
			)
		);

		return [decl, ...stmts];
	}

	private applyFixups(node: ts.Block, ctx: Context) {
		const visitedNodes = new Set<ts.Node>();
		const visitedStmts = new Set<ts.Statement>();
		const result= ts.transform(node, [(context: ts.TransformationContext) => (node) => 
			ts.visitNode(node, function visit(node): ts.Node {
				if (ts.isFunctionExpression(node) || ts.isIdentifier(node)) {
					return node;
				}
				if (visitedNodes.has(node)) {
					//console.log('loop node detected');
					return ts.factory.createEmptyStatement();
				} 
				
				visitedNodes.add(node);

				if (ts.isBlock(node)) {
					return ts.visitEachChild(node, visit, context);
					// const stmts = Array.from(node.statements);
					// const fixups = stmts.filter(s => ctx.fixups.has(s));
					// if (fixups.length) {
					// 	for (const fixup of fixups) {
					// 		const newStmts = ctx.fixups.get(fixup)!();
					// 		stmts.splice(stmts.indexOf(fixup), 1, ...newStmts);
					// 	}

					// 	for (let i = 0; i < stmts.length; i++) {
					// 		if (visitedStmts.has(stmts[i])) {
					// 			console.log('loop detected');
					// 			stmts.splice(i, 1);
					// 			i--;
					// 		} else {
					// 			visitedStmts.add(stmts[i]);
					// 			stmts[i] = ts.visitEachChild(stmts[i], visit, context);
					// 		}
					// 	}

					// 	return node; //TODO
					// 	return ts.factory.createBlock(stmts, true);
					// }
					
				}

				return ts.visitEachChild(node, visit, context);
			} as ts.Visitor)
		]);
		return result.transformed[0];
	}

	private combineIfDoWhile<T extends ts.Node>(node: T) {
		const test= ts.transform(node, [(context: ts.TransformationContext) => (node) => 
			ts.visitNode(node, function visit(node): ts.Node {
				if (ts.isIfStatement(node)
				&& ts.isBlock(node.thenStatement)
				&& node.thenStatement.statements.length === 1
				&& ts.isDoStatement(node.thenStatement.statements[0])
				&& !node.elseStatement
				&& JSON.stringify(node.expression) === JSON.stringify(node.thenStatement.statements[0].expression)) {
					return ts.factory.createWhileStatement(node.expression, node.thenStatement.statements[0].statement);
				}
				return ts.visitEachChild(node, visit, context);
			} as ts.Visitor)
		]);
		return test.transformed[0];
	}

	private combindeFor<T extends ts.Node>(node: T) {
		const test= ts.transform(node, [(context: ts.TransformationContext) => (node) => 
			ts.visitNode(node, (function visit(this: Decompiler, node): ts.Node {
				if (ts.isBlock(node)) {
					const stmt = Array.from(node.statements);
					for (let i = 1; i < stmt.length; i++) {
						const current = stmt[i];
						const last = stmt[i - 1];
	
						if (ts.isWhileStatement(current)
						&& ts.isBlock(current.statement)
						&& ts.isVariableStatement(last)
						&& last.declarationList.declarations.length === 1
						&& last.declarationList.declarations[0].initializer
						&& ts.isNumericLiteral(last.declarationList.declarations[0].initializer)) {
							const end = current.statement.statements[current.statement.statements.length-1];
							if (ts.isExpressionStatement(end)
							&& ts.isBinaryExpression(end.expression)
							&& end.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
							&& ts.isIdentifier(end.expression.left)
							&& ts.isBinaryExpression(end.expression.right)
							&& end.expression.right.operatorToken.kind === ts.SyntaxKind.PlusToken
							&& ts.isIdentifier(end.expression.right.left)
							&& end.expression.left === end.expression.right.left
							&& ts.isNumericLiteral(end.expression.right.right)) {

								const inner = ts.factory.createBlock(current.statement.statements.slice(0, current.statement.statements.length-1), true);

								const increment = end.expression.right.right.text === '1'
									? ts.factory.createPostfixIncrement(end.expression.left)
									: end.expression;

								const loop = ts.factory.createForStatement(last.declarationList, current.expression, increment, inner);
								const renamed = this.rename(loop, end.expression.left, ts.factory.createUniqueName('i', ts.GeneratedIdentifierFlags.Optimistic));

								stmt[i] = renamed;
								stmt.splice(i-1, 1);
								i--;
							}
						}
					}
					node = ts.factory.createBlock(stmt, true);
				}

				return ts.visitEachChild(node, visit.bind(this), context);
			} as ts.Visitor).bind(this))
		]);
		return test.transformed[0];
	}

	private rename<T extends ts.Node>(node: T, oldName: ts.Identifier, newName: ts.Identifier) {
		const test= ts.transform(node, [(context: ts.TransformationContext) => (node) => 
			ts.visitNode(node, function visit(node): ts.Node {
				if (node === oldName) {
					return newName;
				}

				return ts.visitEachChild(node, visit, context);
			} as ts.Visitor)
		]);
		return test.transformed[0];
	}

	private createSourcefile(filename: string, ast: ts.Node[], languageVersion: ts.ScriptTarget): ts.SourceFile {
		const dummy = ts.createSourceFile(filename, 'dummy', languageVersion); // need at least 1 node
	
		return ts.transform(
			dummy,
			[ transformContext => sourceFile => ts.visitEachChild(sourceFile, () => ast, transformContext) ]
		).transformed[0];
	}

	private debug(stmt: ts.Statement) {
		const src = ts.createSourceFile('x.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

		ts.factory.updateSourceFile(src, [stmt]);
		
		const printer = ts.createPrinter();
		const result = printer.printNode(ts.EmitHint.Unspecified, stmt, src);
		console.log(result);
	}
	private debugBlock(stmts: ts.Block) {
		const src = ts.createSourceFile('x.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

		ts.factory.updateSourceFile(src, stmts.statements);
		
		const printer = ts.createPrinter();
		const result = printer.printNode(ts.EmitHint.Unspecified, stmts, src);
		console.log(result);
	}
}