import fs from 'fs';
import { Decompiler } from './decomp';
import { Disassembler } from './disasm';
import { Parser } from './parser';
import { Verify } from './verify';


const data = fs.readFileSync('../hermes/objects.bundle');
const parser = new Parser(data);
const header = parser.parse();

const disasm = new Disassembler(data, header);
const decomp = new Decompiler(disasm, header);
const result = decomp.decompile('result.js');

const verify = new Verify();
verify.verify(result, data);

console.log(result);
fs.writeFileSync('result.js', result);