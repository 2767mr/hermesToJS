import fs from 'fs';
import ts from 'typescript';

export class Printer {
	print(stmt: ts.Statement, file: string) {
		const src = ts.createSourceFile(file, '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
		ts.factory.updateSourceFile(src, [stmt]);
		
		const printer = ts.createPrinter();
		fs.writeFileSync(file, printer.printNode(ts.EmitHint.Unspecified, stmt, src));
	}
}