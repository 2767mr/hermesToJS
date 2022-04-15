import fs from 'fs';
import { createPrinter } from 'typescript';
import { Decompiler } from './decomp';
import { Disassembler } from './disasm';
import { Optimizer } from './optimizer';
import { Parser } from './parser';
import { Verify } from './verify';


const data = fs.readFileSync('../hermes/test.bundle');
const parser = new Parser(data);
const header = parser.parse();

const disasm = new Disassembler(data, header);
const decomp = new Decompiler(disasm, header);
const result = decomp.decompile('result.js');
const optimized = new Optimizer().optimize(result);
const text = createPrinter().printFile(optimized);

const verify = new Verify();
verify.verify(text, data);

console.log(result);
fs.writeFileSync('result.js', text);