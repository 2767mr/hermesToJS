import rawOpCodes from './assets/opcode.json';
import { FunctionHeader, HBCHeader } from './parser';

export class Disassembler {
	private readonly opCodes = Object.keys(rawOpCodes) as Array<keyof typeof rawOpCodes>;

	private static readonly decoder = new TextDecoder();

	private readonly operandType: Record<string, [number, (bytes: Uint8Array) => number]> = {
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
		const name = this.getString(func.functionName);
		console.log(name);

		const bc = this.getByteCode(func);

		const insts = [];
		for (let i = 0; i < bc.length; i++) {
			const opcode = this.opCodes[bc[i]];
			const operands = rawOpCodes[opcode];

			const opVal: (number | string)[] = [];
			for (const operand of operands) {
				const isStr = operand.endsWith(':S');
				const op = !isStr ? operand : operand.substring(0, operand.length - 2);
					
				const [size, conv_to] = this.operandType[op];
				const val = conv_to(bc.slice(i, i+size));
				i+=size;

				if (isStr) {
					opVal.push('"' + this.getString(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"');
				} else {
					opVal.push(op + ':' + val);
				}
			}

			insts.push([opcode, opVal]);
			console.log(opcode, ...opVal);
		}

		console.log(func);
	}

	private getString(sid: number) {
		if (sid < 0 || sid > this.header.header.stringCount) {
			throw new Error('Invalid string ID');
		}

		const entry = this.header.stringTableEntries[sid];
		const overflowEntry = this.header.stringTableOverflowEntries[sid];

		// stringStorage = self.getObj()["stringStorage"]
		// stringTableOverflowEntries = self.getObj()["stringTableOverflowEntries"]

		const overflow = entry.length >= ((1 << 8) - 1);

		const isUTF16 = entry.isUTF16;
		const offset = overflow ? overflowEntry.offset : entry.offset;
		const length = overflow ? overflowEntry.length : entry.length;

		const multiplier = isUTF16 ? 1 : 2; 

		const bytes = this.header.stringStorage.slice(offset, offset + length * multiplier);
		return isUTF16 ? Buffer.from(bytes).toString('hex') : Disassembler.decoder.decode(bytes);
	}

	private getByteCode(func: FunctionHeader) {
		const start = func.offset - this.header.instOffset;
		const end = start + func.bytecodeSizeInBytes;

		return this.header.inst.slice(start, end);
	}

	private toUInt8(bytes: Uint8Array) {
		return bytes[0];
	}
	private toUInt16(bytes: Uint8Array) {
		return new Uint16Array(bytes)[0];
	}

	private toUInt32(bytes: Uint8Array) {
		return new Uint32Array(bytes)[0];
	}

	private toInt8(bytes: Uint8Array) {
		return new Int8Array(bytes)[0];
	}
	private toInt32(bytes: Uint8Array) {
		return new Int32Array(bytes)[0];
	}

	private toDouble(bytes: Uint8Array) {
		return new Float64Array(bytes)[0];
	}
}