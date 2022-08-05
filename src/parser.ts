import structure from './assets/structure.json';
import { Reader } from './reader';


export type Header = {
    [T in keyof typeof structure.header]: (number | number[]);
}

export interface FunctionHeader {
    flags: number;
    offset: number;
    infoOffset: number;
    bytecodeSizeInBytes: number;
    functionName: number;
	paramCount: number;
	frameSize: number;
    [key: string]: unknown;
}

export interface StringTableEntry {
    isUTF16: 0 | 1;
    length: number;
    offset: number;
}
export interface StringTableOverflowEntry {
    length: number;
    offset: number;
}

export interface RegExpTableEntry {
    length: number;
    offset: number;
}
export interface CJSModuleTableEntry {
    first: number;
    second: number;
}


export interface HBCHeader {
    header: Header;
    functionHeaders: FunctionHeader[];
    stringKinds: number[];
    identifierHashes: number[];
    stringTableEntries: StringTableEntry[];
    stringTableOverflowEntries: StringTableOverflowEntry[];
    stringStorage: Uint8Array;
    arrayBuffer: number[];
    objKeyBuffer: number[];
    objValueBuffer: number[];
    regExpTable: RegExpTableEntry[];
    regExpStorage: number | number[];
    cjsModuleTable: CJSModuleTableEntry[];

    instOffset: number;
    inst: ArrayBufferLike;

	arrayValuesRaw: DataView;
	objKeyValuesRaw: DataView;
	objValueValuesRaw: DataView;
}

export class Parser {
	private readonly reader;

	public constructor(
		data: Uint8Array
	) { 
		this.reader = new Reader(data);
	}

	public parse(): HBCHeader {
		const header: Header = {} as Header;
		for (const [key, value] of Object.entries(structure.header)) {
			header[key as keyof typeof structure.header] = this.read(this.cast(value));
		}
		//console.log(header);
        
		this.align();

        
		const functionHeaders: FunctionHeader[] = [];
		for (let i = 0; i < header.functionCount; i++) {
			const functionHeader: FunctionHeader = {} as FunctionHeader;
			for (const [key, value] of Object.entries(structure.SmallFuncHeader)) {
				functionHeader[key] = this.read(this.cast(value));
			}
        
			if ((functionHeader['flags'] >> 5) & 1) {
				functionHeader['small'] = JSON.parse(JSON.stringify(functionHeader));
				const pos = this.reader.tell();
				const large_offset = (functionHeader['infoOffset'] << 16 )  | functionHeader['offset'];
				this.reader.seek(large_offset);
				for (const [key, value] of Object.entries(structure.FuncHeader)){
					functionHeader[key] = this.read(this.cast(value));
				}
				this.reader.seek(pos);
			}
            
			functionHeaders.push(functionHeader);
		}

		this.align();

		const stringKinds: number[] = new Array(header.stringKindCount as number);
		for (let i = 0; i < header.stringKindCount; i++) {
			stringKinds[i] = this.readuint(32) as number;
		}
		this.align();
        
		const identifierHashes: number[] = new Array(header.identifierCount as number);
		for (let i = 0; i < header.identifierCount; i++) {
			identifierHashes[i] = this.readuint(32) as number;
		}
		this.align();
        
		const stringTableEntries: StringTableEntry[] = [];
		for (let i = 0; i < header.stringCount; i++) {
			const stringTableEntry: StringTableEntry = {} as StringTableEntry;
			for (const [key, value] of Object.entries(structure.SmallStringTableEntry)) {
				stringTableEntry[key as keyof StringTableEntry] = this.read(this.cast(value)) as 0 | 1;
			}
        
			stringTableEntries.push(stringTableEntry);
		}
		this.align();
        
		const stringTableOverflowEntries: StringTableOverflowEntry[] = [];
		for (let i = 0; i < header.overflowStringCount; i++) {
			const stringTableEntry: StringTableOverflowEntry = {} as StringTableOverflowEntry;
			for (const [key, value] of Object.entries(structure.OverflowStringTableEntry)) {
				stringTableEntry[key as keyof StringTableOverflowEntry] = this.read(this.cast(value)) as number;
			}
        
			stringTableOverflowEntries.push(stringTableEntry);
		}
		this.align();

		const stringStorage = this.reader.readSlice(header.stringStorageSize as number);
		this.align();
		const arrayBuffer = this.read([structure.ArrayBuffer[0] as string, structure.ArrayBuffer[1] as number, header.arrayBufferSize as number]) as number[];
		this.align();
		const objKeyBuffer = this.read([structure.ObjKeyBuffer[0] as string, structure.ObjKeyBuffer[1] as number, header.objKeyBufferSize as number]) as number[];
		this.align();
		const objValueBuffer = this.read([structure.ObjValueBuffer[0] as string, structure.ObjValueBuffer[1] as number, header.objValueBufferSize as number]) as number[];
		this.align();
		
		const regExpTable: RegExpTableEntry[] = [];
		for (let i = 0; i < header.regExpCount; i++) {
			const regExpEntry: RegExpTableEntry = {} as RegExpTableEntry;
			for (const [key, value] of Object.entries(structure.RegExpTableEntry)) {
				regExpEntry[key as keyof RegExpTableEntry] = this.read(this.cast(value)) as number;
			}
        
			regExpTable.push(regExpEntry);
		}
		this.align();

		const regExpStorage = this.read([structure.RegExpStorage[0] as string, structure.RegExpStorage[1] as number, header.regExpStorageSize as number]);
		this.align();
		
		const cjsModuleTable: CJSModuleTableEntry[] = [];
		for (let i = 0; i < header.cjsModuleCount; i++) {
			const regExpEntry: CJSModuleTableEntry = {} as CJSModuleTableEntry;
			for (const [key, value] of Object.entries(structure.CJSModuleTable)) {
				regExpEntry[key as keyof CJSModuleTableEntry] = this.read(this.cast(value)) as number;
			}
        
			cjsModuleTable.push(regExpEntry);
		}
		this.align();

		const result: HBCHeader = {
			arrayBuffer,
			cjsModuleTable,
			functionHeaders,
			header,
			identifierHashes,
			objKeyBuffer,
			objValueBuffer,
			regExpStorage,
			regExpTable,
			stringKinds,
			stringStorage,
			stringTableEntries,
			stringTableOverflowEntries,
			instOffset: this.reader.tell(),
			inst: this.reader.readAll(),
			arrayValuesRaw: new DataView(new Uint8Array(arrayBuffer).buffer),
			objKeyValuesRaw: new DataView(new Uint8Array(objKeyBuffer).buffer),
			objValueValuesRaw: new DataView(new Uint8Array(objValueBuffer).buffer)
		};

		// console.log('started slp');

		// Object.assign(result, JSON.parse(require('fs').readFileSync('slp.json', 'utf8')));

		// result.arrayValues = SerializedLiteralParser.parse(array, result);
		// result.objKeyValues = SerializedLiteralParser.parse(new Uint8Array(objKeyBuffer), result);
		// result.objValueValues = SerializedLiteralParser.parse(new Uint8Array(objValueBuffer), result);

		// require('fs').writeFileSync('slp.json', JSON.stringify({
		// 	arrayValues: result.arrayValues,
		// 	objKeyValues: result.objKeyValues,
		// 	objValueValues: result.objValueValues,
		// }));
		// console.log('parsed slp');

		return result;
	}

	private cast(input: (string | number)[]): [string, number, number] {
		if (!input 
            || input.length != 3 
            || typeof input[0] !== 'string'
            || typeof input[1] !== 'number'
            || typeof input[2] != 'number') {
			throw new Error('Format error in structure.json');
		}
		return input as unknown as [string, number, number];
	}

	private align() {
		this.reader.pad(4);
	}

	private read([type, bits, n]: [string, number, number]) {
		const r: number[] = [];
		for (let i = 0; i < n; i++) {
			switch (type) {
			case 'uint':
				r.push(this.readuint(bits));
				break;
			case 'int':
				r.push(this.readint(bits));
				break;
			case 'bit':
				r.push(this.readbits(bits));
				break;
			default:
				throw new Error(`Data type ${type} is not supported.`);
			}
		}
        
		if (r.length == 1)
			return r[0];
		else
			return r;
	}

	private readuint(bits = 64, signed = false) {
		if (bits % 8 != 0) {
			throw new Error('Not supported');
		}
		if (bits == 8) {
			return this.reader.readBytes(1);
		}

		let x = 0;
		for (let s = 0; s < bits; s += 8) {
			const b = this.reader.readBytes(1);
			x |= b << s;
		}

        
		if (signed && (x & (1<<(bits-1)))) {
			x = -((1<<(bits)) - x);
		}
            
		if (Math.log2(x) > bits) {
			console.warn(`--> Int ${x} longer than ${bits} bits`);
		}

		return x;
	}
	private readint(bits = 64) {
		return this.readuint(bits, true);
	}
	private readbits(bits = 8) {
		let x = 0;
		let s = 0;

		if (this.reader.bitCounter % 8 != 0 && bits >= this.reader.bitCounter) {
			const count = this.reader.bitCounter;
			const b = this.reader.readBits(count);
			x |= b;
			s = count;
			bits -= count;
		}
        
		for (let i = 0; i < ((bits / 8) >>> 0); i++) {
			const b = this.reader.readBits(8);
			x |= b << s;
			s += 8;
		}

		const r = bits % 8;
		if (r != 0) {
			const b = this.reader.readBits(r, true);
			x |= (b & ((1 << r) - 1)) << s;
		}
        
		return x;
	}
}