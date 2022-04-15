import { ChildProcess, exec } from 'child_process';
import fs from 'fs/promises';
import process from 'process';
import { createPrinter } from 'typescript';
import { Decompiler } from './decomp';
import { Disassembler } from './disasm';
import { Optimizer } from './optimizer';
import { Parser } from './parser';


export class Verify {
	async verify(program: string, original: Buffer) {
		const oparser = new Parser(original);
		const oheader = oparser.parse();

		const odisasm = new Disassembler(original, oheader);
		const oglobal = odisasm.disassemble(oheader.functionHeaders[0]);

		await fs.writeFile('tmp.js', program);
		const hermes = exec('hermes -out tmp.bundle --emit-binary tmp.js', {
			cwd: process.cwd(),
			env: process.env,
		});
		await this.exitPromise(hermes);

		const bundle = await fs.readFile('tmp.bundle');
		const parser = new Parser(bundle);
		const header = parser.parse();

		const disasm = new Disassembler(bundle, header);
		const global = disasm.disassemble(header.functionHeaders[0]);
		for (const func of header.functionHeaders) {
			disasm.disassemble(func);
		}
		const x = new Decompiler(disasm, header);
		const y = x.decompile('test.js');
		const text = createPrinter().printFile(new Optimizer().optimize(y));
		await fs.writeFile('result_verify.js', text);

		try { await fs.unlink('tmp.bundle'); } catch {/* */}
		try { await fs.unlink('tmp.js'); } catch {/* */ }
	}

	private exitPromise(childProcess: ChildProcess): Promise<void> {
		return new Promise((resolve, reject) => {
			childProcess.once('exit', (code: number) => {
				if (code === 0) {
					resolve(undefined);
				} else {
					reject(new Error('Exit with error code: ' + code));
				}
			});
			childProcess.stdout?.on('data', data => {
				console.log('stdout: ' + data.toString());
			});

			childProcess.stderr?.on('data', data => {
				console.log('stderr: ' + data.toString());
			});
			childProcess.once('error', (err: Error) => {
				reject(err);
			});
		});
	}
}