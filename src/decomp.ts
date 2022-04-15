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
	public constructor(
		private readonly disasm: Disassembler,
		private readonly header: HBCHeader,
	) { }

	public decompile(outfile: string) {
		const context: Context = {
			environment: {} as Environment,
			blocksConversion: new Map(),
			nodeConversion: new Map(),
			fixups: new Map(),
			environments: new Map(),
			params: [ts.factory.createUniqueName('p')],
			registers: [],
		};
		const result = this.decompileFuction(this.header.functionHeaders[0], context);

		return this.createSourcefile(outfile, Array.from(result.statements), ts.ScriptTarget.Latest);
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
			return this.assign(ctx, node, 0, 
				ts.factory.createStringLiteral(node.instr.operands[1].value as string));
		case 'LoadConstZero':
			return this.assign(ctx, node, 0, 
				ts.factory.createNumericLiteral(0));
		case 'LoadConstUndefined':
			return this.assign(ctx, node, 0, 
				ts.factory.createIdentifier('undefined'));
		case 'LoadConstFalse':
			return this.assign(ctx, node, 0, 
				ts.factory.createFalse());
		case 'LoadConstUInt8':
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
			return this.toIdentifier(ctx, node, 1); //TODO: check
		case 'JNotLess':
			return ts.factory.createLessThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JLess':
			return ts.factory.createLessThan(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JEqual':
			return ts.factory.createEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JNotEqual':
			return ts.factory.createEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JStrictEqual':
			return ts.factory.createStrictEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
		case 'JStrictNotEqual':
			return ts.factory.createStrictEquality(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2));
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
		case 'Sub':
			return this.assign(ctx, node, 0, 
				ts.factory.createSubtract(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Mul':
			return this.assign(ctx, node, 0, 
				ts.factory.createMultiply(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Div':
			return this.assign(ctx, node, 0, 
				ts.factory.createDivide(this.toIdentifier(ctx, node, 1), this.toIdentifier(ctx, node, 2)));
		case 'Jmp':
			return ts.factory.createVoidZero();
		case 'Ret':
			left = this.toIdentifier(ctx, node, 0);
			return ts.factory.createReturnStatement(left) as unknown as ts.Expression;
		case 'Mov':
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
			ctx.environments.set(dummyExpression, env);
			return dummyExpression;
		}
		case 'GetEnvironment': {
			const count = node.instr.operands[1].value as number;
			let result = ctx.environment;
			for (let i = 0; i < count; i++) {
				result = result.parent;
			}

			for (const [dummy, env] of ctx.environments) {
				if (env === result) {
					return dummy;
				}
			}
			//Ideally unreachable
			const dummyExpression = ts.factory.createVoidZero();
			ctx.environments.set(dummyExpression, result);
			return dummyExpression;
		}
		case 'StoreToEnvironment': {
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
		case 'LoadFromEnvironment': {
			const dummyExpression = this.toIdentifier(ctx, node, 1);
			const index = node.instr.operands[2].value as number;

			const env = ctx.environments.get(dummyExpression);
			if (!env) {
				throw new Error('Invalid environment in LoadFromEnvironment arg 1');
			}

			return this.getEnvVariable(env, index); 
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
			return this.createClosure(left, node.instr.operands[2].value as number, ctx);
		case 'ToNumber':
			return this.assign(ctx, node, 0, 
				ts.factory.createCallExpression(ts.factory.createIdentifier('Number'), undefined, [this.toIdentifier(ctx, node, 1)]));
		case 'CallBuiltin':
			//TODO
			return ts.factory.createCallExpression(ts.factory.createIdentifier(node.instr.operands[1].value as string), undefined, []);
		default:
			throw new Error('Opcode conversion not implemented: ' + node.instr.opcode);
		}
	}

	//TODO: remove
	private nextID = 1;
	private toIdentifier(ctx: Context, node: InstructionNode, index: number) {
		const result = ctx.registers[node.instr.operands[index].value as number];
		if (result) {
			return result;
		}

		return ctx.registers[node.instr.operands[index].value as number]
			= ts.factory.createUniqueName('r' + (this.nextID++));
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
			params.push(ts.factory.createUniqueName('p')); //ts.GeneratedIdentifierFlags.ReservedInNestedScopes
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
		return ts.factory.createFunctionExpression(
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
	}

	private getEnvVariable(env: Environment, index: number) {
		if (env.variables[index]) {
			return env.variables[index];
		}
		
		const ident = ts.factory.createUniqueName('c');
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
				ctx.registers.filter(i => i).map(
					i => ts.factory.createVariableDeclaration(i)
				),
				ts.NodeFlags.Let
			)
		);

		return [decl, ...stmts];
	}

	private applyFixups(node: ts.Block, ctx: Context) {
		const result= ts.transform(node, [(context: ts.TransformationContext) => (node) => 
			ts.visitNode(node, function visit(node): ts.Node {
				if (ts.isBlock(node)) {
					const stmts = Array.from(node.statements);
					const fixups = stmts.filter(s => ctx.fixups.has(s));
					if (fixups.length) {
						for (const fixup of fixups) {
							const newStmts = ctx.fixups.get(fixup)!();
							stmts.splice(stmts.indexOf(fixup), 1, ...newStmts);
						}
						return ts.visitEachChild(ts.factory.createBlock(stmts, true), visit, context);
					}
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