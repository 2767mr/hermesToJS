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
		console.log(flow);
		
		this.markDataFlow(flow, new Set());

		console.log(Array.from(this.nodeMap.values()));


		for (const val of this.nodeMap.values()) {
			console.log(val.instr.ip, val.instr.opcode, 
				'depends', JSON.stringify(val.dependsOn.map(d => d?.map(o => o?.instr?.ip))), 
				'affects', JSON.stringify(val.affects.map(d => d.instr.ip)));
		}
		

		this.convertBlock(flow, this.nodeMap, new Map(), new Set());

		// for (const [instr, node] of nodes) {
		// 	if (node.affects.length == 0) {
		// 		console.log('emit', node);
		// 	} else if (node.affects.length > 1) {
		// 		console.log('save', node);
		// 	}
		// }
	}

	private convertBlock(block: Block, nodeMap: Map<Instruction, InstructionNode>, converted: Map<InstructionNode, ts.Expression>, visited: Set<Block>) {
		if (visited.has(block)) {
			return;
		}
		visited.add(block);

		for (const instr of block.insts) {
			const node = nodeMap.get(instr);
			if (!node) {
				throw new Error('Instruction not in node dictionary');
			}
			if (node.affects.length == 0) {
				this.emit(node, converted);
			} else if (node.affects.length > 1) {
				this.save(node, converted);
			}
		}

		this.convertBlock(block.fLabel, nodeMap, converted, visited);
		this.convertBlock(block.tLabel, nodeMap, converted, visited);
	}

	private emit(node: InstructionNode, converted: Map<InstructionNode, ts.Expression>) {
		const r = this.convertInstruction(node, converted);
		converted.set(node, r);

		if (node.instr.opcode !== 'Jmp' && node.instr.opcode.startsWith('J')) {
			const stmt = ts.factory.createIfStatement(r, ts.factory.createEmptyStatement());
			this.debug(stmt);
			//console.log('emit', node, r);
		} else {
			const stmt = ts.factory.createExpressionStatement(r);
			this.debug(stmt);
			//console.log('emit', node, r);
		}
	}

	private static varId = 1;
	private save(node: InstructionNode, converted: Map<InstructionNode, ts.Expression>) {
		const name = 'v' + Decompiler.varId;
		const id = ts.factory.createUniqueName(name);
		Decompiler.varId++;
		
		const r = this.convertInstruction(node, converted);

		if (ts.isIdentifier(r) && r.text === 'globalThis') {
			converted.set(node, r);
		} else if (node.affects.includes(node)) {
			const register = node.instr.operands.find(o => o.kind === SourceSinkType.SOURCE)?.value as number;
			const sourceIndex = node.instr.operands.findIndex(o => o.kind === SourceSinkType.SINK && o.value === register);
			const target = converted.get(node.dependsOn[sourceIndex][0]) as ts.Identifier;
			converted.set(node, target ?? id);
			
			const stmt = ts.factory.createExpressionStatement(ts.factory.createAssignment(target, r));
			this.debug(stmt);

		} else {
			converted.set(node, id);
			const v = ts.factory.createVariableDeclaration(id, undefined, undefined, r);
			const stmt = ts.factory.createVariableStatement(undefined, [v]);
			this.debug(stmt);
			//console.log('save', node, v);
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

	private debug(stmt: ts.Statement) {
		const src = ts.createSourceFile('x.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

		ts.factory.updateSourceFile(src, [stmt]);
		
		const printer = ts.createPrinter();
		const result = printer.printNode(ts.EmitHint.Unspecified, stmt, src);
		console.log(result);
	}
}