import rawOpCodes from './assets/opcode.json';
import { FunctionHeader, HBCHeader } from './parser';

export type OpCodeType = keyof typeof rawOpCodes;

export interface Operand {
	type: string;
	value: string | number;
}

export interface Instruction {
	ip: number;
	opcode: OpCodeType;
	operands: Operand[];
}

export class Disassembler {
	private readonly opCodes = Object.keys(rawOpCodes) as Array<OpCodeType>;

	private static readonly decoder = new TextDecoder();

	private readonly operandType: Record<string, [number, (bytes: ArrayBuffer) => number]> = {
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

		const insts: Array<Instruction> = [];
		for (let i = 0; i < bc.byteLength;) {
			const ip = i;

			const opcode = this.opCodes[this.toUInt8(bc.slice(ip))];
			const ops = rawOpCodes[opcode];
			i++;
			
			const operands: Operand[] = [];
			for (let j = 0; j < ops.length; j++) {
				const operand = ops[j];
				const isStr = operand.endsWith(':S');
				const type = !isStr ? operand : operand.substring(0, operand.length - 2);
					
				const [size, conv_to] = this.operandType[type];
				const value = conv_to(bc.slice(i, i+size));
				i+=size;

				if (isStr) {
					operands.push({ type, value: this.getString(value)});
				} else {
					operands.push({ type, value });
				}
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
		const end = start + func.bytecodeSizeInBytes;

		return this.header.inst.slice(start, end);
	}

	private toUInt8(bytes: ArrayBufferLike) {
		return new Uint8Array(bytes)[0];
	}
	private toUInt16(bytes: ArrayBufferLike) {
		return new Uint16Array(bytes)[0];
	}

	private toUInt32(bytes: ArrayBufferLike) {
		return new Uint32Array(bytes)[0];
	}

	private toInt8(bytes: ArrayBufferLike) {
		return new Int8Array(bytes)[0];
	}
	private toInt32(bytes: ArrayBufferLike) {
		return new Int32Array(bytes)[0];
	}

	private toDouble(bytes: ArrayBufferLike) {
		return new Float64Array(bytes)[0];
	}
}