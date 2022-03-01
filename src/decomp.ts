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


export class Decompiler {
	private readonly nodeMap = new Map<Instruction, InstructionNode>();

	public constructor(
		private readonly disasm: Disassembler,
		private readonly header: HBCHeader,
	) { }

	public decompile() {
		this.decompileFuction(this.header.functionHeaders[0]);
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

	private decompileFuction(fHeader: FunctionHeader) {
		const insts = this.disasm.disassemble(fHeader);
		const labels = this.labels(insts);
		const blocks = this.blocks(insts, labels);
		const flow = this.blockFlow(blocks);
		//console.log(flow);
		
		this.markDataFlow(flow, new Set());
		this.inlineCalls();

		//console.log(Array.from(this.nodeMap.values()));


		for (const val of this.nodeMap.values()) {
			console.log(val.instr.ip, val.instr.opcode, 
				'depends', JSON.stringify(val.dependsOn.map(d => d?.map(o => o?.instr?.ip))), 
				'affects', JSON.stringify(val.affects.map(d => d.instr.ip)));
		}
		

		const stmts = this.convertBlock(flow, this.nodeMap, new Map(), new Map());
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
	}

	private convertBlock(block: Block, nodeMap: Map<Instruction, InstructionNode>, converted: Map<InstructionNode, ts.Expression>, visited: Map<Block, ts.Statement[]>, until?: Block) {
		if (visited.has(block)) {
			return visited.get(block) as ts.Statement[];
		}

		let stmts: ts.Statement[] = [];		
		visited.set(block, stmts);

		for (const instr of block.insts) {
			const node = nodeMap.get(instr);
			if (!node) {
				throw new Error('Instruction not in node dictionary');
			}
			if (node.affects.length == 0) {
				const expr = this.emit(node, converted);

				if (node.instr.opcode === 'Jmp') {
					if (until != block.tLabel) {
						stmts.push(...this.convertBlock(block.tLabel, nodeMap, converted, visited, until));
					}
					return stmts;
				}

				if (node.instr.opcode.startsWith('J')) {
					if (node.instr.operands[0].value < 0) {
						stmts = [
							ts.factory.createDoStatement(
								ts.factory.createBlock(this.convertBlock(block.tLabel, nodeMap, converted, visited, block)),
								expr
							)
						];
						visited.set(block, stmts);
					} else if (node.instr.opcode.startsWith('JNot')) {
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, nodeMap, converted, visited, jmp.tLabel)),
								ts.factory.createBlock(this.convertBlock(block.tLabel, nodeMap, converted, visited, jmp.tLabel))));
							stmts.push(...this.convertBlock(jmp.tLabel, nodeMap, converted, visited, until));
						} else {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.fLabel, nodeMap, converted, visited, block.tLabel))));
							stmts.push(...this.convertBlock(block.tLabel, nodeMap, converted, visited, until));
						}
					} else {
						const jmp = this.endsInJmp(block.fLabel, new Set(), block.tLabel.insts[0].ip);
						if (jmp) {
							stmts.push(ts.factory.createIfStatement(expr, 
								ts.factory.createBlock(this.convertBlock(block.tLabel, nodeMap, converted, visited, jmp.tLabel)),
								ts.factory.createBlock(this.convertBlock(block.fLabel, nodeMap, converted, visited, jmp.tLabel))));
							stmts.push(...this.convertBlock(jmp.tLabel, nodeMap, converted, visited, until));
						} else {
							stmts.push(ts.factory.createIfStatement(ts.factory.createLogicalNot(expr),
								ts.factory.createBlock(this.convertBlock(block.fLabel, nodeMap, converted, visited, block.tLabel))));
							stmts.push(...this.convertBlock(block.tLabel, nodeMap, converted, visited, until));
						}
					}
				} else {
					stmts.push(ts.factory.createExpressionStatement(expr));
				}
			} else if (node.affects.length > 1 
				|| (node.affects[0].dependsOn.find(d => d?.includes(node))?.length ?? 0) > 1) {
				const stmt = this.save(node, converted);
				if (stmt) {
					stmts.push(stmt);
				}
			}
		}

		if (!block.insts[block.insts.length - 1].opcode.startsWith('J') && until != block.fLabel) {
			stmts.push(...this.convertBlock(block.fLabel, nodeMap, converted, visited, until));
		}

		return stmts;
	}

	private emit(node: InstructionNode, converted: Map<InstructionNode, ts.Expression>) {
		const r = this.convertInstruction(node, converted);
		converted.set(node, r);

		if (node.instr.opcode !== 'Jmp' && node.instr.opcode.startsWith('J')) {
			//const stmt = ts.factory.createIfStatement(r, ts.factory.createEmptyStatement());
			//this.debug(stmt);
			//console.log('emit', node, r);
		} else {
			//const stmt = ts.factory.createExpressionStatement(r);
			//this.debug(stmt);
			//console.log('emit', node, r);
		}

		return r;
	}

	private save(node: InstructionNode, converted: Map<InstructionNode, ts.Expression>): ts.Statement | undefined {
		const id = ts.factory.createUniqueName('l');
		
		const r = this.convertInstruction(node, converted);

		if (ts.isIdentifier(r) && r.text === 'globalThis') {
			converted.set(node, r);
			return;

		} else if (node.affects.includes(node)) {
			const register = node.instr.operands.find(o => o.kind === SourceSinkType.SOURCE)?.value as number;
			const sourceIndex = node.instr.operands.findIndex(o => o.kind === SourceSinkType.SINK && o.value === register);
			const target = converted.get(node.dependsOn[sourceIndex][0]) as ts.Identifier;
			converted.set(node, target ?? id);
			
			const stmt = ts.factory.createExpressionStatement(ts.factory.createAssignment(target, r));
			//this.debug(stmt);

			return stmt;

		} else if ((node.affects[0].dependsOn.find(d => d?.includes(node))?.length ?? 0) > 1) {
			const deps = node.affects[0].dependsOn.find(d => d?.includes(node)) ?? [];
			const dep = deps.find(d => converted.has(d));
			const target = converted.get(dep ?? node);

			if (target) {
				converted.set(node, target);
				const stmt = ts.factory.createExpressionStatement(ts.factory.createAssignment(target, r));
				return stmt;
			} else {
				converted.set(node, id);
				const v = ts.factory.createVariableDeclaration(id, undefined, undefined, r);
				const stmt = ts.factory.createVariableStatement(undefined, [v]);
				return stmt;
			}
			
			//this.debug(stmt);

		} else {
			converted.set(node, id);
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

	private convertInstruction(node: InstructionNode, converted: Map<InstructionNode, ts.Expression>) : ts.Expression {
		if (converted.has(node)) {
			return converted.get(node) as ts.Expression;
		}

		let left: ts.Expression;

		switch (node.instr.opcode) {
		case 'LoadConstString':
			return ts.factory.createStringLiteral(node.instr.operands[1].value as string);
		case 'LoadConstZero':
			return ts.factory.createNumericLiteral(0);
		case 'LoadConstUInt8':
			return ts.factory.createNumericLiteral(node.instr.operands[1].value as number);
		case 'GetGlobalObject':
			return ts.factory.createIdentifier('globalThis');
		case 'JNotLess':
			return ts.factory.createLessThan(this.convertInstruction(node.dependsOn[1][0], converted), this.convertInstruction(node.dependsOn[2][0], converted));
		case 'JLess':
			return ts.factory.createLessThan(this.convertInstruction(node.dependsOn[1][0], converted), this.convertInstruction(node.dependsOn[2][0], converted));
		case 'JEqual':
			return ts.factory.createEquality(this.convertInstruction(node.dependsOn[1][0], converted), this.convertInstruction(node.dependsOn[2][0], converted));
		case 'JNotEqual':
			return ts.factory.createEquality(this.convertInstruction(node.dependsOn[1][0], converted), this.convertInstruction(node.dependsOn[2][0], converted));
		case 'TryGetById':
			left = this.convertInstruction(node.dependsOn[1][0], converted);
			if (ts.isIdentifier(left) && left.text === 'globalThis') {
				return ts.factory.createIdentifier(node.instr.operands[3].value as string);
			}

			return ts.factory.createPropertyAccessExpression(left, node.instr.operands[3].value as string);
		case 'GetByIdShort':
			return ts.factory.createPropertyAccessExpression(this.convertInstruction(node.dependsOn[1][0], converted), node.instr.operands[3].value as string);
		case 'Call2':
			if (node.dependsOn[2]) {
				return ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(this.convertInstruction(node.dependsOn[1][0], converted), 'call'), 
					undefined, 
					[this.convertInstruction(node.dependsOn[2][0], converted), this.convertInstruction(node.dependsOn[3][0], converted)]);
			}
			return ts.factory.createCallExpression(this.convertInstruction(node.dependsOn[1][0], converted), undefined, [this.convertInstruction(node.dependsOn[3][0], converted)]);
		case 'AddN':
			return ts.factory.createAdd(this.convertInstruction(node.dependsOn[1][0], converted), this.convertInstruction(node.dependsOn[2][0], converted));
		case 'Jmp':
			return ts.factory.createVoidZero();
		case 'Ret':
			return ts.factory.createVoidZero();
		case 'Mov':
			return this.convertInstruction(node.dependsOn[1][0], converted);
		default:
			throw new Error('Opcode conversion not implemented: ' + node.instr.opcode);
		}
	}

	private markDataFlow(block: Block, visited: Set<Block>) {
		if (visited.has(block)) {
			return;
		}
		visited.add(block);

		for (let i = 0; i < block.insts.length; i++) {
			const instr = block.insts[i];
			const node = this.getNode(instr);
			for (let j = 0; j < instr.operands.length; j++) {
				const op = instr.operands[j];
				if (op.kind === SourceSinkType.SOURCE) {
					if (op.type !== 'Reg8') {
						throw new Error('Not implemented: source non reg8');
					}

					this.markDataFlowRegister(block, i+1, new Set(), node, op.value as number);
				}
			}
		}
		this.markDataFlow(block.fLabel, visited);
		this.markDataFlow(block.tLabel, visited);
	}

	private markDataFlowRegister(block: Block, instOffset: number, visited: Set<Block>, start: InstructionNode, register: number, skipCheck = true) {
		if (!skipCheck) {
			if (visited.has(block)) {
				return;
			}
			visited.add(block);
		}
		
		for (let i = instOffset; i < block.insts.length; i++) {
			const instr = block.insts[i];
			const node = this.getNode(instr);
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

		this.markDataFlowRegister(block.fLabel, 0, visited, start, register, false);
		this.markDataFlowRegister(block.tLabel, 0, visited, start, register, false);
	}
	private getNode(instr: Instruction) {
		if (this.nodeMap.has(instr)) {
			return this.nodeMap.get(instr) as InstructionNode;
		} 

		const result: InstructionNode = {instr, affects: [], dependsOn: []};
		this.nodeMap.set(instr, result);
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

	private inlineCalls() {
		for (const node of this.nodeMap.values()) {
			if (node.instr.opcode === 'Call2'
			&& node.dependsOn[2].length === 1
			&& node.dependsOn[2][0].affects.length === 2
			&& node.dependsOn[2][0].affects[0] === node.dependsOn[1][0]
			&& node.dependsOn[2][0].affects[1] === node) {
				node.dependsOn[2][0].affects.pop();
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