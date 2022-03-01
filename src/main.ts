import fs from 'fs';
import { Decompiler } from './decomp';
import { Disassembler } from './disasm';
import { Parser } from './parser';

const data = fs.readFileSync('../hermes/test.bundle');
const parser = new Parser(data);
const header = parser.parse();

const disasm = new Disassembler(data, header);
const decomp = new Decompiler(disasm, header);
decomp.decompile();