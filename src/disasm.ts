import rawOpCodes from './assets/opcode.json';
import { FunctionHeader, HBCHeader } from './parser';

export type OpCodeType = keyof typeof rawOpCodes;

export interface Operand {
	type: string;
	value: string | number | number[];
}

export interface Instruction {
	ip: number;
	opcode: OpCodeType;
	operands: Operand[];
}

export class Disassembler {
	private readonly opCodes = Object.keys(rawOpCodes) as Array<OpCodeType>;

	private static readonly decoder = new TextDecoder();

	private readonly operandType: Record<string, [number, (bytes: DataView, offset: number) => number]> = {
		'Reg8': [1, this.toUInt8],
		'Reg32': [4, this.toUInt32],
		'UInt8': [1, this.toUInt8],
		'UInt16': [2, this.toUInt16],
		'UInt32': [4, this.toUInt32],
		'Addr8': [1, this.toInt8],
		'Addr32': [4, this.toInt32],
		// 'Reg32': [4, this.toUInt32],
		'Imm32': [4, this.toUInt32],
		'Double': [8, this.toDouble],
	};

	public constructor(
		private readonly data: Uint8Array,
		private readonly header: HBCHeader,
	) { }

	public disassemble(func: FunctionHeader) {
		//const name = this.getString(func.functionName);
		//console.log(name);

		const bc = this.getByteCode(func);
		const all = this.getAllByteCode(func);

		const insts: Array<Instruction> = [];
		for (let i = 0; i < bc.byteLength;) {
			const ip = i;

			const opcode = this.opCodes[this.toUInt8(bc, ip)];
			const ops = rawOpCodes[opcode];
			i++;
			
			const operands: Operand[] = [];
			for (let j = 0; j < ops.length; j++) {
				const operand = ops[j];
				const isStr = operand.endsWith(':S');
				const type = !isStr ? operand : operand.substring(0, operand.length - 2);
					
				const [size, conv_to] = this.operandType[type];
				const value = conv_to(bc, i);
				i+=size;

				if (isStr) {
					operands.push({ type, value: this.getString(value)});
				} else {
					operands.push({ type, value });
				}
			}

			if (opcode === 'SwitchImm') {
				const jumpTable = operands[1].value as number;
				//const defaultAddr = inst.operands[2].value as number; //Is already covered by default logic because of type Addr32
				const min = operands[3].value as number;
				const max = operands[4].value as number;

				const bcOffset = func.offset - this.header.instOffset;
				const addr = ip + jumpTable;
				const start = this.align(addr + bcOffset, 4) - bcOffset;
				const count = max - min + 1;
				const values = new Array<number>(count);

				for (let i = 0; i < count; i++) {
					values[i] = this.toInt32(all, start + i * 4);
				}
					
				operands[1].value = values;
			}

			insts.push({ip, opcode, operands});
			//console.log(ip, opcode, ...opVal);
		}

		return insts;
	}


	public getName(func: FunctionHeader) {
		return this.getString(func.functionName);
	}


	private getString(sid: number) {
		if (sid < 0 || sid > this.header.header.stringCount) {
			//debugger;
			throw new Error('Invalid string ID');
		}

		const entry = this.header.stringTableEntries[sid];
		const overflowEntry = this.header.stringTableOverflowEntries[sid];

		// stringStorage = self.getObj()["stringStorage"]
		// stringTableOverflowEntries = self.getObj()["stringTableOverflowEntries"]

		const overflow = entry.length >= ((1 << 8) - 1);
		try {
			const isUTF16 = entry.isUTF16;
			const offset = overflow ? overflowEntry.offset : entry.offset;
			const length = overflow ? overflowEntry.length : entry.length;

			const multiplier = isUTF16 ? 2 : 1; 

			const bytes = this.header.stringStorage.slice(offset, offset + length * multiplier);
			return isUTF16 ? Buffer.from(bytes).toString('hex') : Disassembler.decoder.decode(bytes);
		} catch (e) {
			return 'Decompiler error: ' + e;
		}
	}

	private getByteCode(func: FunctionHeader) {
		const start = func.offset - this.header.instOffset;
		return new DataView(this.header.inst, start, func.bytecodeSizeInBytes);
	}

	private getAllByteCode(func: FunctionHeader) {
		const start = func.offset - this.header.instOffset;
		return new DataView(this.header.inst, start);
	}

	private toUInt8(bytes: DataView, offset: number) {
		return bytes.getUint8(offset);
	}
	private toUInt16(bytes: DataView, offset: number) {
		return bytes.getUint16(offset, true);
	}

	private toUInt32(bytes: DataView, offset: number) {
		return bytes.getUint32(offset, true);
	}

	private toInt8(bytes: DataView, offset: number) {
		return bytes.getInt8(offset);
	}
	private toInt32(bytes: DataView, offset: number) {
		return bytes.getInt32(offset, true);
	}

	private toDouble(bytes: DataView, offset: number) {
		return bytes.getFloat64(offset, true);
	}

	private align(value: number, align: number) {
		const leftover = value % align;
		if (leftover === 0) {
			return value;
		}

		return value + (align - leftover);
	}
}