import fs from 'fs';
import { Disassembler } from './disasm';
import { Parser } from './parser';

const data = fs.readFileSync('../index.android.bundle');
const parser = new Parser(data);
const header = parser.parse();

const disasm = new Disassembler(data, header);
for (const func of header.functionHeaders) {
	disasm.disassemble(func);
}