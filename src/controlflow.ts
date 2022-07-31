import { Disassembler, Instruction, OpCodeType } from './disasm';
import { FunctionHeader } from './parser';

export interface CodeBlock {
	ip: number;
	insts: Instruction[];
}


export interface JumpControlflow {
	type: 'j';
	code: CodeBlock;

	target: ControlflowNode;

	isLoop: boolean;
}

export interface ConditionalControlflow {
	type: 'c';
	code: CodeBlock;

	then: ControlflowNode;
	else: ControlflowNode;
	after?: ControlflowNode;

	isLoop: boolean;
}

export interface SwitchControlflow {
	type: 's',
	code: CodeBlock;

	blocks: ControlflowNode[];
	default: ControlflowNode;
	after?: ControlflowNode;
}

export interface LoopControlflow {
	type: 'l';
	code: CodeBlock;

	body: ControlflowNode;
	after: ControlflowNode;
}

export interface ReturnControlflow {
	type: 'r',
	code: CodeBlock;
	empty: boolean;
}

const returnNode: ReturnControlflow = Object.freeze({
	type: 'r',
	code: {
		insts: [],
		ip: -1,
	},
	empty: false,
});

export type ControlflowNode = ConditionalControlflow | JumpControlflow | ReturnControlflow | SwitchControlflow | LoopControlflow;


const conditionalsArray: OpCodeType[] = [
	'JEqual',
	'JEqualLong',
	'JGreater',
	'JGreaterEqual',
	'JGreaterEqualLong',
	'JGreaterEqualN',
	'JGreaterEqualNLong',
	'JGreaterLong',
	'JGreaterN',
	'JGreaterNLong',
	'JLess',
	'JLessEqual',
	'JLessEqualLong',
	'JLessEqualN',
	'JLessEqualNLong',
	'JLessLong',
	'JLessN',
	'JLessNLong',
	'JStrictEqual',
	'JStrictEqualLong',
	'JNotEqual',
	'JNotEqualLong',
	'JNotGreater',
	'JNotGreaterEqual',
	'JNotGreaterEqualLong',
	'JNotGreaterEqualN',
	'JNotGreaterEqualNLong',
	'JNotGreaterLong',
	'JNotGreaterN',
	'JNotGreaterNLong',
	'JNotLess',
	'JNotLessEqual',
	'JNotLessEqualLong',
	'JNotLessEqualN',
	'JNotLessEqualNLong',
	'JNotLessLong',
	'JNotLessN',
	'JNotLessNLong',
	'JStrictNotEqual',
	'JStrictNotEqualLong',
	'JmpFalse',
	'JmpFalseLong',
	'JmpTrue',
	'JmpTrueLong',
	'JmpUndefined',
	'JmpUndefinedLong',
];
const conditionals = new Set<OpCodeType>(conditionalsArray);


export class ControlflowBuilder {
	constructor(
		private readonly disassembler: Disassembler,
	) {
		
	}

	public buildControlFlow(header: FunctionHeader) {
		const insts = this.disassembler.disassemble(header);
		
		const labels = this.buildLabels(insts);

		// const p = this.printInstrs(header);
		// debugger;

		const blocks = this.buildBlocks(insts, labels);

		const flow = this.buildBasicControlflow(blocks.get(0)!, blocks, Array.from(labels).sort((a, b) => a - b), new Map(), 0);
	

		this.buildLoops(flow);
		this.buildSwitch(flow);
		this.buildIf(flow);
		
		return this.buildTree(flow);
	}
	private printInstrs(header: FunctionHeader) {
		let result = '';
		try {
			const instrs = this.disassembler.disassemble(header);
			for (const instr of instrs) {
				result += `  ${instr.ip}: ${instr.opcode}`;
	
				for (const op of instr.operands) {
					result += ' ' + op.type + ':' + op.value;
				}
	
				result += '\n';
			}
		} catch (e) {
			result += e + '\n';
		}

		return result;
	}

	private buildLabels(insts: Instruction[]) {
		const result = new Set<number>([0]);

		for (let i = 0; i < insts.length; i++) {
			const inst = insts[i];
			for (const operand of inst.operands) {
				if (operand.type === 'Addr8' || operand.type === 'Addr32') {
					const offset = operand.value as number;
					result.add(inst.ip + offset);

					result.add(insts[i + 1]?.ip ?? 0);
				}
			}

			if (inst.opcode === 'SwitchImm') {
				const labels = inst.operands[1].value as number[];
				for (const label of labels) {
					result.add(inst.ip + label);
				}
			}
		}

		return result;
	}

	private buildBlocks(insts: Instruction[], labels: Set<number>) {
		const result = new Map<number, CodeBlock>();

		let current: CodeBlock = {
			insts: [],
			ip: insts[0]?.ip ?? 0,
		};
		for (const inst of insts) {
			if (labels.has(inst.ip)) {
				if (current.insts.length > 0) {
					result.set(current.ip, current);
					current = {
						insts: [],
						ip: inst.ip,
					};
				}
			}
			current.insts.push(inst);
		}
		if (current.insts.length > 0) {
			result.set(current.ip, current);
		}

		return result;
	}

	private buildBasicControlflow(current: CodeBlock, blocks: Map<number, CodeBlock>, labels: number[], built: Map<number, ControlflowNode>, depth: number): ControlflowNode {
		// if (depth > 900) {
		// 	return returnNode;
		// }
		
		if (built.has(current.ip)) {
			return built.get(current.ip)!;
		}
		
		const result: ControlflowNode = {
			type: 'j',
			code: current,
			target: returnNode,
			isLoop: false,
		} as ControlflowNode;
		built.set(current.ip, result);
		
		const last = current.insts[current.insts.length - 1];

		if (conditionals.has(last.opcode)) {
			const targetIP = last.ip + +last.operands[0].value;
			const target = blocks.get(targetIP);

			const elseIP = labels.find(l => l > last.ip);
			const elseBlock = blocks.get(elseIP!);
			if (!elseBlock && targetIP > current.ip) {
				throw new Error('conditional last inside function?');
			}

			const elseNode: ControlflowNode = elseBlock 
				? this.buildBasicControlflow(elseBlock, blocks, labels, built, depth + 1) 
				: returnNode; //TODO: turn this returnNode into a runtime-unreachable 

			if (!target) {
				throw new Error('conditional to outside function?');
			}

			const c = result as ConditionalControlflow;
			c.type = 'c';
			c.then = this.buildBasicControlflow(target, blocks, labels, built, depth + 1);
			c.else = elseNode;
			c.isLoop = target.ip <= current.ip;
		} else if (last.opcode === 'SwitchImm') {
			const targets = last.operands[1].value as number[];

			const switchBlocks = new Array(targets.length);
			for (let i = 0; i < targets.length; i++) {
				const target = blocks.get(targets[i] + last.ip);
				if (!target) {
					throw new Error('switch case to outside function?');
				}

				switchBlocks[i] = this.buildBasicControlflow(target, blocks, labels, built, depth + 1);
			}
			
			const defaultTargetIP = last.operands[2].value as number;
			const defaultTarget = blocks.get(defaultTargetIP + last.ip);
			if (!defaultTarget) {
				throw new Error('switch case to outside function?');
			}


			const s = result as SwitchControlflow;
			s.type = 's';
			s.blocks = switchBlocks;
			s.default = this.buildBasicControlflow(defaultTarget, blocks, labels, built, depth + 1);
		} else if (last.opcode === 'Jmp' || last.opcode === 'JmpLong') {
			const targetIP = last.ip + +last.operands[0].value;
			const target = blocks.get(targetIP);
			if (!target) {
				throw new Error('jmp to outside function?');
			}

			const j = result as JumpControlflow;
			j.type = 'j';
			j.target = this.buildBasicControlflow(target, blocks, labels, built, depth + 1);
			j.isLoop = j.target.code.ip <= j.code.ip;
		} else if (last.opcode === 'Ret') {
			const j = result as JumpControlflow;
			j.type = 'j';
			j.target = returnNode;
		} else {
			const afterIP = labels.find(l => l > last.ip);
			const afterBlock = blocks.get(afterIP!);

			const j = result as JumpControlflow;
			j.type = 'j';
			j.target = afterBlock
				? this.buildBasicControlflow(afterBlock, blocks, labels, built, depth + 1)
				: returnNode;
		}


		return result;
	}

	private buildLoops(root: ControlflowNode) {
		this.visitPostfix(root, (node) => {
			if (node.type === 'c' && node.isLoop && node.then.type !== 'l') {
				const then = node.then;
				const elseNode = node.else;

				const newNode = Object.assign({}, then);
				for (const key of Object.keys(then)) {
					if (key !== 'ip') {
						delete (then as unknown as Record<string, unknown>)[key];
					}
				}

				const l = then as unknown as LoopControlflow;
				l.type = 'l';
				l.body = newNode;
				l.after = elseNode;

				node.then = l;
			}
		});
		
		return;
	}

	private buildSwitch(root: ControlflowNode) {
		this.visitPostfix(root, (node) => {
			if (node.type === 's' && !node.after) {
				const path: ControlflowNode[] = [];
				this.followFirstPath(node.default, path, 0);

				for (const block of node.blocks) {
					this.findCommonSuccessor(block, path);
				}

				if (path[0] === returnNode) {
					node.after = returnNode;
					return;
				}

				node.after = Object.assign({}, path[0]);
				const e = path[0] as ReturnControlflow;
				e.type = 'r';
				e.code = returnNode.code;
				e.empty = true;
			}
		});
	}

	private buildIf(root: ControlflowNode) {
		this.visitPostfix(root, (node) => {
			if (node.type === 'c' && !node.after && !node.isLoop) {
				const path: ControlflowNode[] = [];
				this.followFirstPath(node.then, path, 0);

				this.findCommonSuccessor(node.else, path);
				
				if (path[0] === returnNode) {
					node.after = returnNode;
					return;
				}

				node.after = Object.assign({}, path[0]);
				const e = path[0] as ReturnControlflow;
				e.type = 'r';
				e.code = returnNode.code;
				e.empty = true;
			}
		});
	}

	/**
	 * Actually tries to follow the shortest path to return but we don't know which it is so just pick the first.
	 */
	private followFirstPath(node: ControlflowNode, result: ControlflowNode[], depth: number) {
		if (depth > 450) {
			return;
		}

		result.push(node);

		switch (node.type) {
		case 'r':
			break;
		case 'j':
			this.followFirstPath(node.target, result, depth + 1);
			break;
		case 'c':
			this.followFirstPath(node.after ?? node.else, result, depth + 1);
			break;
		case 's':
			this.followFirstPath(node.default, result, depth + 1);
			break;
		case 'l':
			this.followFirstPath(node.after, result, depth + 1);
			break;
		default:
			throw new Error('Unknown cf type ' + node['type']);
		}
	}

	private findCommonSuccessor(root: ControlflowNode, path: ControlflowNode[]) {
		const queue: ControlflowNode[] = [root];
		const visited = new Set<ControlflowNode>();

		while (queue.length > 0) {
			const next = queue.pop()!;
			if (visited.has(next)) {
				continue;
			}
			visited.add(next);

			queue.push(...this.doFindCommonSuccessor(next, path));

			//path always has return node so return if it's already done.
			if (path.length <= 1) {
				return;
			}
		}
	}
	private doFindCommonSuccessor(root: ControlflowNode, path: ControlflowNode[]) {
		const next: ControlflowNode[] = [];
		this.visit(root, (node) => {
			const index = path.indexOf(node);
			if (index !== -1) {
				path.splice(0, index);
				return false;
			}

			//after is guaranteed to be executed so skip other branches (they are already optimized and returns in other branches does not affect the result)
			if ('after' in node && node.after) {
				next.push(node.after);
				return false;
			}

			return true;
		});
		return next;
	}

	private buildTree(root: ControlflowNode) {
		const visited = new Set<ControlflowNode>();
		const queue = [root];

		while (queue.length > 0) {
			const node = queue.shift()!;
			
			const keys = this.nextKeys(node);
			for (const key of keys) {
				let next = this.getValue(node, key);

				if (visited.has(next)) {
					next = Object.assign({}, next);
					this.setValue(node, key, next);
				}
				visited.add(next);
			}
		}

		return root;
	}

	public buildAndPrint(header: FunctionHeader) {
		const ctrlFlow = this.buildControlFlow(header);
		return this.convertToString(ctrlFlow, 0, new Set());
	}

	private convertToString(node: ControlflowNode, level: number, printed: Set<ControlflowNode>) {
		// if (printed.has(node)) {
		// 	return '';
		// }
		// printed.add(node);

		let result = '';

		switch (node.type) {
		case 'c': {
			result += this.convertBlockToString(node.code, level);
			if (!node.isLoop) {
				result += '  '.repeat(level + 1) + 'if (!flag) {\n\n';
				result += this.convertToString(node.else, level + 1, printed);
				result += '  '.repeat(level + 1) + '} else {\n\n';
				result += this.convertToString(node.then, level + 1, printed);
				result += '  '.repeat(level + 1) + '}\n\n';
			}
			if (node.after) {
				result += this.convertToString(node.after, level, printed);
			}
			break;
		}
		case 'j': {
			result += this.convertBlockToString(node.code, level);
			result += '  '.repeat(level + 1) + `//jmp(${node.target.code?.ip})\n\n`;
			result += this.convertToString(node.target, level, printed);
			break;
		}
		case 'r': {
			if (!node.empty) {
				result += '  '.repeat(level + 1) + 'return;\n\n';
			}
			break;
		}
		case 's': {
			result += this.convertBlockToString(node.code, level);
			result += '  '.repeat(level + 1) + 'switch (value) {\n\n';
			for (const block of node.blocks) {
				result += '  '.repeat(level + 1) + 'case X: {\n\n';
				result += this.convertToString(block, level + 2, printed);
				result += '  '.repeat(level + 1) + '}\n\n';
			}
			result += '  '.repeat(level + 1) + 'default: {\n\n';
			result += this.convertToString(node.default, level + 2, printed);
			result += '  '.repeat(level + 1) + '}\n\n';
			result += '  '.repeat(level + 1) + '}\n\n';
			if (node.after) {
				result += this.convertToString(node.after, level, printed);
			}
			break;
		}
		case 'l': {
			result += '  '.repeat(level + 1) + 'do {\n';
			result += this.convertToString(node.body, level + 1, printed);
			result += '  '.repeat(level + 1) + '} while (value);\n\n';
			result += this.convertToString(node.after, level, printed);
			break;
		}
		}

		return result;
	}

	private convertBlockToString(block: CodeBlock, level: number) {
		let result = '';
		for (const inst of block.insts) {
			result += '  '.repeat(level + 1) + `/* ${inst.ip}: */ ${inst.opcode}(`;
	
			for (const op of inst.operands) {
				result += '"' + op.type + ':' + op.value + '", ';
			}
			
			result += ')\n';
		}
		return result + '\n';
	}

	public visit(root: ControlflowNode, cb: (node: ControlflowNode) => void | boolean) {
		const visited = new Set<ControlflowNode>();
		const queue = [root];

		while (queue.length > 0) {
			const next = queue.shift()!;

			const result = cb(next);
			if (result === false) {
				return;
			}

			
			for (const nextNode of this.next(next)) {
				if (nextNode && !visited.has(nextNode)) {
					queue.push(nextNode);
					visited.add(nextNode);
				}
			}
		}
	}
	private visitPostfix(node: ControlflowNode, cb: (node: ControlflowNode) => void) {
		// this.doVisitPostfix(node, cb, new Set(), 0);
		const visitQueue = [];

		const nodes = new Set<ControlflowNode>();
		const visited = new Set<ControlflowNode>();
		this.visit(node, (n) => {nodes.add(n);});

		while (nodes.size > 0) {
			let changed = false;
			for (const node of nodes) {
				if (this.next(node).every(n => visited.has(n) || 
				(node.type === 'c' && node.isLoop && node.then === n) ||
				(node.type === 'j' && node.isLoop))) {
					visitQueue.push(node);
					visited.add(node);
					nodes.delete(node);
					changed = true;
				}
			}
			if (!changed) {
				for (const node of nodes) {
					console.log(JSON.stringify({ type: node.type, ip: node.code.ip }));
					for (const keys of this.nextKeys(node)) {
						const next = this.getValue(node, keys);
						console.log(visited.has(next) ? 'has' : 'missing', JSON.stringify(keys), JSON.stringify({ type: next.type, ip: next.code.ip }));
						
					}
				}
				throw new Error('Unknown kind of loop');
			}
		}

		for (const n of visitQueue) {
			cb(n);
		}
	}
	
	private doVisitPostfix(node: ControlflowNode, cb: (node: ControlflowNode) => void, visited: Set<ControlflowNode>, depth: number) {
		if (depth > 750) {
			console.error('doVisitPostfix: stack limit exceeded');
			return;
		}

		if (visited.has(node)) {
			return;
		}
		visited.add(node);

		for (const nextNode of this.next(node)) {
			if (nextNode) {
				this.doVisitPostfix(nextNode, cb, visited, depth + 1);
			}
		}

		cb(node);
	}

	private nextKeys(node: ControlflowNode) {
		switch (node.type) {
		case 'r':
			return [];
		case 'j':
			return ['target'];
		case 'l':
			return ['body', 'after'];
		case 's':
			if (node.after) {
				return [...Object.keys(node.blocks).map(i => ['blocks', i] as [string, string]), 'default', 'after'];
			} else {
				return [...Object.keys(node.blocks).map(i => ['blocks', i] as [string, string]), 'default' ];
			}
		case 'c':
			if (node.after) {
				return ['then', 'else', 'after'];
			} else {
				return ['then', 'else'];
			}
		}
	}

	private getValue(node: ControlflowNode, key: string | [string, string]) {
		if (key instanceof Array) {
			return (node as unknown as Record<string, Record<string, ControlflowNode>>)[key[0]][key[1]];
		} else {
			return (node as unknown as Record<string, ControlflowNode>)[key];
		}
	}
	private setValue(node: ControlflowNode, key: string | [string, string], value: ControlflowNode) {
		if (key instanceof Array) {
			(node as unknown as Record<string, Record<string, ControlflowNode>>)[key[0]][key[1]] = value;
		} else {
			(node as unknown as Record<string, ControlflowNode>)[key] = value;
		}
	}

	private next(node: ControlflowNode) {
		return this.nextKeys(node).map(key => this.getValue(node, key));

		// switch (node.type) {
		// case 'r':
		// 	return [];
		// case 'j':
		// 	return [node.target];
		// case 'l':
		// 	return [node.body, node.after];
		// 	break;
		// case 's':
		// 	if (node.after) {
		// 		return [...node.blocks, node.default, node.after];
		// 	} else {
		// 		return [...node.blocks, node.default ];
		// 	}
		// case 'c':
		// 	if (!node.isLoop) {
		// 		if (node.after) {
		// 			return [node.then, node.else, node.after];
		// 		} else {
		// 			return [node.then, node.else];
		// 		}
		// 	} else {
		// 		if (node.after) {
		// 			return [node.else, node.after];
		// 		} else {
		// 			return [node.else];
		// 		}
		// 	}
		// }
	}
}