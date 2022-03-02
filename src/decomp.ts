import * as ts from 'typescript';
import { Disassembler, Instruction, Operand, SourceSinkType } from './disasm';
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
	dependsOn: InstructionNode[][];
	affects: InstructionNode[];
	inline?: true;
}

interface Environment {
	parent: Environment;
	variables: ts.Identifier[];
}

interface Context {
	environment: Environment;
	nodeMap: Map<Instruction, InstructionNode>;
	nodeConversion: Map<InstructionNode, ts.Expression>;
	nodeConverted: Set<InstructionNode>;
	blocksConversion: Map<Block, ts.Statement[]>;
	fixups: Map<ts.Statement, () => ts.Statement[]>;
	environments: Map<ts.Expression, Environment>;
	params: ts.Identifier[];
}


export class Decompiler {
	public constructor(
		private readonly disasm: Disassembler,
		private readonly header: HBCHeader,
	) { }

	public decompile() {
		const context: Context = {
			environment: {} as Environment,
			blocksConversion: new Map(),
			nodeConversion: new Map(),
			nodeConverted: new Set(),
			nodeMap: new Map(),
			fixups: new Map(),
			environments: new Map(),
			params: [ts.factory.createUniqueName('p')]
		};
		this.decompileFuction(this.header.functionHeaders[0], context);
	}
	private asRegister(operand: string | number) {
		if (typeof operand !== 'string' || !operand.startsWith('Reg8:')) {
			throw new Error(`Invalid register: ${operand}`);
		}
		return Number(operand.substring('Reg8:'.length));
	}
	private asUInt8(operand: string | number) {
		if (typeof operand !== 'string' || !operand.startsWith('UInt8:')) {
			throw new Error(`Invalid register: ${operand}`);
		}
		return Number(operand.substring('UInt8:'.length));
	}
	private asOffset(operand: Operand, ip: number) {
		if ((operand.type !== 'Addr8' && operand.type !== 'Addr32') || typeof operand.value !== 'number') {
			throw new Error(`Invalid number: ${operand}`);
		}
		return operand.value + ip;
	}
	private asString(operand: string | number) {
		if (typeof operand !== 'string') {
			throw new Error(`Invalid string: ${operand}`);
		}
		return operand;
	}

	private decompileFuction(fHeader: FunctionHeader, context: Context): ts.Block {
		context.environment.parent = context.environment;
		const insts = this.disasm.disassemble(fHeader);
		const labels = this.labels(insts);
		const blocks = this.blocks(insts, labels);
		const flow = this.blockFlow(blocks);
		//console.log(flow);
		
		this.markDataFlow(flow, new Set(), context);
		this.inlineCalls(context);

		//console.log(Array.from(this.nodeMap.values()));


		for (const val of context.nodeMap.values()) {
			console.log(val.instr.ip, val.instr.opcode, 
				'depends', JSON.stringify(val.dependsOn.map(d => d?.map(o => o?.instr?.ip))), 
				'affects', JSON.stringify(val.affects.map(d => d.instr.ip)));
		}
		

		const stmts = this.convertBlock(flow, context);
		const block = ts.factory.createBlock(stmts);
		const blockWhile = this.combineIfDoWhile(block);
		const blockFor = this.combindeFor(blockWhile);
		this.debugBlock(blockFor);

		// for (const [instr, node] of nodes) {
		// 	if (node.affects.length == 0) {
		// 		console.log('emit', node);
		// 	} else if (node.affects.length > 1) {
		// 		console.log('save', node);
		// 	}
		// }

		return blockFor;
	}

	private convertBlock(block: Block, context: Context, until?: Block) {
		if (context.blocksConversion.has(block)) {
			return context.blocksConversion.get(block) as ts.Statement[];
		}

		let stmts: ts.Statement[] = [];		
		context.blocksConversion.set(block, stmts);

		for (const instr of block.insts) {
			const node = context.nodeMap.get(instr);
			if (!node) {
				throw new Error('Instruction not in node dictionary');
			}
			if (node.affects.length == 0) {
				const expr = this.emit(node, context);

				if (node.instr.opcode === 'Jmp') {
					if (until != block.tLabel) {
						stmts.push(...this.convertBlock(block.tLabel, context, until));
					}
					return stmts;
				}

				if (node.instr.opcode.startsWith('J')) {
					if (node.instr.operands[0].value < 0) {
						stmts = [
							ts.factory.createDoStatement(
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, block)),
								expr
							)
						];
						context.blocksConversion.set(block, stmts);
					} else if (node.instr.opcode.startsWith('JNot')) {
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, jmp.tLabel)),
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, jmp.tLabel))));
							stmts.push(...this.convertBlock(jmp.tLabel, context, until));
						} else {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, block.tLabel))));
							stmts.push(...this.convertBlock(block.tLabel, context, until));
						}
					} else {
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.tLabel, context, jmp.tLabel)),
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, jmp.tLabel))));
							stmts.push(...this.convertBlock(jmp.tLabel, context, until));
						} else {
							stmts.push(ts.factory.createIfStatement(ts.factory.createLogicalNot(expr),
								ts.factory.createBlock(this.convertBlock(block.fLabel, context, block.tLabel))));
							stmts.push(...this.convertBlock(block.tLabel, context, until));
						}
					}
				} else if (ts.isReturnStatement(expr) || ts.isEmptyStatement(expr)) {
					stmts.push(expr);
				} else {
					stmts.push(ts.factory.createExpressionStatement(expr));
				}
			} else if (node.instr.opcode !== 'CreateEnvironment' && (node.affects.length > 1 
				|| (node.affects[0].dependsOn.find(d => d?.includes(node))?.length ?? 0) > 1)) {
				const stmt = this.save(node, context);
				if (stmt) {
					stmts.push(stmt);
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

		// if (node.instr.opcode !== 'Jmp' && node.instr.opcode.startsWith('J')) {
		// 	const stmt = ts.factory.createIfStatement(r, ts.factory.createEmptyStatement());
		// 	this.debug(stmt);
		// 	console.log('emit', node, r);
		// } else {
		// 	const stmt = ts.factory.createExpressionStatement(r);
		// 	this.debug(stmt);
		// 	console.log('emit', node, r);
		// }

		return r;
	}

	private save(node: InstructionNode, context: Context): ts.Statement | undefined {
		const id = ts.factory.createUniqueName('l');
		
		const r = this.convertInstruction(node, context);

		if (ts.isIdentifier(r) && r.text === 'globalThis') {
			context.nodeConversion.set(node, r);
			return;

		} else if (node.affects.includes(node)) {
			const register = node.instr.operands.find(o => o.kind === SourceSinkType.SOURCE)?.value as number;
			const sourceIndex = node.instr.operands.findIndex(o => o.kind === SourceSinkType.SINK && o.value === register);
			const target = context.nodeConversion.get(node.dependsOn[sourceIndex][0]) as ts.Identifier;
			context.nodeConversion.set(node, target ?? id);
			
			const stmt = ts.factory.createExpressionStatement(ts.factory.createAssignment(target, r));
			//this.debug(stmt);

			return stmt;

		} else if ((node.affects[0].dependsOn.find(d => d?.includes(node))?.length ?? 0) > 1) {
			const deps = node.affects[0].dependsOn.find(d => d?.includes(node)) ?? [];
			const dep = deps.find(d => context.nodeConversion.has(d));
			const target = context.nodeConversion.get(dep ?? node);

			if (target) {
				context.nodeConversion.set(node, target);
				const stmt = ts.factory.createExpressionStatement(ts.factory.createAssignment(target, r));
				return stmt;
			} else {
				context.nodeConversion.set(node, id);
				const v = ts.factory.createVariableDeclaration(id, undefined, undefined, r);
				const stmt = ts.factory.createVariableStatement(undefined, [v]);
				return stmt;
			}
			
			//this.debug(stmt);

		} else {
			context.nodeConversion.set(node, id);
			const v = ts.factory.createVariableDeclaration(id, undefined, undefined, r);
			const stmt = ts.factory.createVariableStatement(undefined, [v]);
			//this.debug(stmt);
			//console.log('save', node, v);

			return stmt;
		}
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

	private convertInstruction(node: InstructionNode, context: Context) : ts.Expression {
		if (context.nodeConversion.has(node)) {
			return context.nodeConversion.get(node) as ts.Expression;
		}

		let left: ts.Expression;

		switch (node.instr.opcode) {
		case 'LoadConstString':
			return ts.factory.createStringLiteral(node.instr.operands[1].value as string);
		case 'LoadConstZero':
			return ts.factory.createNumericLiteral(0);
		case 'LoadConstUndefined':
			return ts.factory.createIdentifier('undefined');
		case 'LoadConstUInt8':
			return ts.factory.createNumericLiteral(node.instr.operands[1].value as number);
		case 'LoadParam':
			return context.params[node.instr.operands[1].value as number];
		case 'GetGlobalObject':
			return ts.factory.createIdentifier('globalThis');
		case 'JNotLess':
			return ts.factory.createLessThan(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'JLess':
			return ts.factory.createLessThan(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'JEqual':
			return ts.factory.createEquality(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'JNotEqual':
			return ts.factory.createEquality(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'TryGetById':
			left = this.convertInstruction(node.dependsOn[1][0], context);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return ts.factory.createIdentifier(node.instr.operands[3].value as string);
			}

			return ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string);
		case 'GetByIdShort':
			left = this.convertInstruction(node.dependsOn[1][0], context);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return ts.factory.createIdentifier(node.instr.operands[3].value as string);
			}

			return ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string);
		case 'Call2':
			if (node.dependsOn[2]) {
				return ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.convertInstruction(node.dependsOn[1][0], context), 'call'), 
					undefined, 
					[this.convertInstruction(node.dependsOn[2][0], context), this.convertInstruction(node.dependsOn[3][0], context)]);
			}
			return ts.factory.createCallExpression(this.convertInstruction(node.dependsOn[1][0], context), undefined, [this.convertInstruction(node.dependsOn[3][0], context)]);
		case 'Call4':
			if (node.dependsOn[2]) {
				return ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.convertInstruction(node.dependsOn[1][0], context), 'call'), 
					undefined, 
					[
						this.convertInstruction(node.dependsOn[2][0], context), 
						this.convertInstruction(node.dependsOn[3][0], context), 
						this.convertInstruction(node.dependsOn[4][0], context), 
						this.convertInstruction(node.dependsOn[5][0], context)]);
			}
			return ts.factory.createCallExpression(this.convertInstruction(node.dependsOn[1][0], context), undefined, [
				this.convertInstruction(node.dependsOn[3][0], context),
				this.convertInstruction(node.dependsOn[4][0], context),
				this.convertInstruction(node.dependsOn[5][0], context)
			]);
		case 'AddN':
			return ts.factory.createAdd(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'Add':
			return ts.factory.createAdd(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'Sub':
			return ts.factory.createSubtract(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'Mul':
			return ts.factory.createMultiply(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'Div':
			return ts.factory.createDivide(this.convertInstruction(node.dependsOn[1][0], context), this.convertInstruction(node.dependsOn[2][0], context));
		case 'Jmp':
			return ts.factory.createVoidZero();
		case 'Ret':
			left = this.convertInstruction(node.dependsOn[0][0], context);
			return ts.factory.createReturnStatement(left) as unknown as ts.Expression;
		case 'Mov':
			return this.convertInstruction(node.dependsOn[1][0], context);
		case 'DeclareGlobalVar':
			return ts.factory.createAssignment(ts.factory.createIdentifier(node.instr.operands[0].value as string), ts.factory.createIdentifier('undefined'));
		case 'CreateEnvironment': {
			const dummyStatement = ts.factory.createEmptyStatement();
			const dummyExpression = ts.factory.createVoidZero();
			const env: Environment = {
				parent: context.environment,
				variables: []
			};
			context.fixups.set(dummyStatement, () => env.variables.map(
				v => v ? ts.factory.createVariableStatement(undefined, [
					ts.factory.createVariableDeclaration(v)
				]) : ts.factory.createEmptyStatement()
			));
			context.environments.set(dummyExpression, env);
			return dummyExpression;
		}
		case 'PutById':
			left = this.convertInstruction(node.dependsOn[0][0], context);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return ts.factory.createAssignment(
					ts.factory.createIdentifier(node.instr.operands[3].value as string), 
					this.convertInstruction(node.dependsOn[1][0], context));
			}

			return ts.factory.createAssignment(
				ts.factory.createPropertyAccessExpression(
					left,
					node.instr.operands[3].value as string
				), this.convertInstruction(node.dependsOn[1][0], context));
		case 'CreateClosure':
			left = this.convertInstruction(node.dependsOn[1][0], context);
			return this.createClosure(left, node.instr.operands[2].value as number, context);
		case 'CallBuiltin':
			//TODO
			return ts.factory.createCallExpression(ts.factory.createIdentifier(node.instr.operands[1].value as string), undefined, []);
		default:
			throw new Error('Opcode conversion not implemented: ' + node.instr.opcode);
		}
	}

	private markDataFlow(block: Block, visited: Set<Block>, context: Context) {
		if (visited.has(block)) {
			return;
		}
		visited.add(block);

		for (let i = 0; i < block.insts.length; i++) {
			const instr = block.insts[i];
			const node = this.getNode(instr, context);
			for (let j = 0; j < instr.operands.length; j++) {
				const op = instr.operands[j];
				if (op.kind === SourceSinkType.SOURCE) {
					if (op.type !== 'Reg8') {
						throw new Error('Not implemented: source non reg8');
					}

					this.markDataFlowRegister(block, i+1, new Set(), node, op.value as number, context);
				}
			}
		}
		this.markDataFlow(block.fLabel, visited, context);
		this.markDataFlow(block.tLabel, visited, context);
	}

	private markDataFlowRegister(block: Block, instOffset: number, visited: Set<Block>, start: InstructionNode, register: number, context: Context, skipCheck = true) {
		if (!skipCheck) {
			if (visited.has(block)) {
				return;
			}
			visited.add(block);
		}
		
		for (let i = instOffset; i < block.insts.length; i++) {
			const instr = block.insts[i];
			const node = this.getNode(instr, context);
			for (let j = 0; j < instr.operands.length; j++) {
				const op = instr.operands[j];
				if (op.kind === SourceSinkType.SINK) {
					if (op.type !== 'Reg8') {
						throw new Error('Not implemented: sink non reg8');
					}

					if (op.value === register) {
						if (!start.affects.includes(node)) {
							start.affects.push(node);
						}

						if (!node.dependsOn[j]) {
							node.dependsOn[j] = [start];
						} else {
							node.dependsOn[j].push(start);
						}
					}

				}
			}
			for (const op of instr.operands) {
				if (op.kind === SourceSinkType.SOURCE) {
					if (op.type !== 'Reg8') {
						throw new Error('Not implemented: source non reg8');
					}

					if (op.value === register) {
						return;
					}
				}
			}
		}

		this.markDataFlowRegister(block.fLabel, 0, visited, start, register, context, false);
		this.markDataFlowRegister(block.tLabel, 0, visited, start, register, context, false);
	}

	private createClosure(dummy: ts.Expression, funcId: number, context: Context): ts.Expression {
		const env = context.environments.get(dummy);
		if (!env) throw new Error('Unreachable? Could not resolve environment.');

		const func = this.header.functionHeaders[funcId];

		const params: ts.Identifier[] = [];
		for (let i = 0; i < func.paramCount; i++) {
			params.push(ts.factory.createUniqueName('p'));
		}

		const childContext: Context = {
			blocksConversion: new Map(),
			environment: env,
			environments: new Map(),
			fixups: new Map(),
			nodeConversion: new Map(),
			nodeConverted: new Set(),
			nodeMap: new Map(),
			params: params,
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

	private getNode(instr: Instruction, context: Context) {
		if (context.nodeMap.has(instr)) {
			return context.nodeMap.get(instr) as InstructionNode;
		} 

		const result: InstructionNode = {instr, affects: [], dependsOn: []};
		context.nodeMap.set(instr, result);
		return result;
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

	private inlineCalls(context: Context) {
		for (const node of context.nodeMap.values()) {
			if ((node.instr.opcode === 'Call2' || node.instr.opcode === 'Call4')
			&& node.dependsOn[2].length === 1
			&& node.dependsOn[2][0].affects.length === 2
			&& node.dependsOn[2][0].affects[0] === node.dependsOn[1][0]
			&& node.dependsOn[2][0].affects[1] === node) {
				node.dependsOn[2][0].affects.pop();
				delete node.dependsOn[2];
			} else if ((node.instr.opcode === 'Call2' || node.instr.opcode === 'Call4')
			&& node.dependsOn[2].length === 1
			&& node.dependsOn[2][0].affects.length === 1
			&& node.dependsOn[2][0].affects[0] === node) {
				delete node.dependsOn[2];
			}
		}
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

								const inner = ts.factory.createBlock(current.statement.statements.slice(0, current.statement.statements.length-1));

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
					node = ts.factory.createBlock(stmt);
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