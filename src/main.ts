import fs from 'fs';

import { Beautifier } from './beautifier';
import { Decompiler } from './decomp';
import { Disassembler } from './disasm';
import { Parser } from './parser';
import { Printer } from './printer';


const data = fs.readFileSync('../data/test.bundle');
// const data = fs.readFileSync('../index.android.bundle');
const parser = new Parser(data);
const header = parser.parse();

const disasm = new Disassembler(data, header);
const decomp = new Decompiler(disasm, header);
const beauty = new Beautifier();

console.log('decompiling');
const decompiled = decomp.decompile();

console.log('beautifying');
const result = beauty.beautify(decompiled);

console.log('printing');
new Printer().print(result, 'result2.js');