import ts from 'typescript';
import { DependencyGraph } from './dependency-graph';

function debug(node: ts.Node) {
	return ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, {} as ts.SourceFile);
}

export class Optimizer {
	public optimize(file: ts.SourceFile) {		
		ts.createPrinter().printFile(file);

		file = this.inlineGlobal(file);
		new DependencyGraph(file);
		file = this.inlineSimpleLiteral(file);
		file = this.inlineComplexLiteral(file);
		file = this.writeAfterWrite(file);
		file = this.deleteDanglingLiteral(file);
		return file;
	}

	//Assumes that globalThis has it's own reserved variable and removes it
	private inlineGlobal(file: ts.SourceFile) {
		const globalRegs = new Set<ts.Identifier>();

		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)
					&& ts.isIdentifier(stmt.expression.right)
					&& stmt.expression.right.text === 'globalThis') {
						globalRegs.add(stmt.expression.left);
						stmts.splice(i, 1);
						i--;
					}
				}

				if (ts.isBlock(node)) {
					node = ts.factory.updateBlock(node, stmts);
				} else {
					node = ts.factory.updateSourceFile(node, stmts);
				}
			}
			if (ts.isPropertyAccessExpression(node)
				&& ts.isIdentifier(node.expression)
				&& globalRegs.has(node.expression)) {
				return ts.visitEachChild(node.name, visit, ctx);
			}
			if (ts.isVariableDeclarationList(node)) {
				node = ts.factory.updateVariableDeclarationList(node, node.declarations.filter(d => !globalRegs.has(d.name as ts.Identifier)));
				return node;
			}
			return ts.visitEachChild(node, visit, ctx);
		});
	}

	//Removes unnecessary assignments
	private writeAfterWrite(file: ts.SourceFile) {
		const [waw] = this.analyseWAWBlock(new Set(), new Map(), file);
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
                    && waw.has(stmt)) {
						stmts[i] = ts.factory.createExpressionStatement(stmt.expression.right);
					}
				}
				return ts.visitEachChild(ts.factory.createBlock(stmts), visit, ctx);
			} else if (ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
                    && waw.has(stmt)) {
						stmts[i] = ts.factory.createExpressionStatement(stmt.expression.right);
					}
				}

				node = ts.factory.updateSourceFile(node, stmts);
				return ts.visitEachChild(node, visit, ctx);
			}
			return ts.visitEachChild(node, visit, ctx);
		});
	}
	private analyseWAWBlock(waw: Set<ts.Statement>, written: Map<ts.Identifier, ts.Statement[]>, block: ts.Block | ts.SourceFile) {
		const resultWAW = new Set(waw);
		const resultWritten = new Map(written);

		function merge(
			thenWAW: Set<ts.Statement>, thenWritten: Map<ts.Identifier, ts.Statement[]>,
			elseWAW: Set<ts.Statement>, elseWritten: Map<ts.Identifier, ts.Statement[]>
		) {
			const writtenStmts = new Set(Array.from(resultWritten.values()).flat());
			for (const waw of thenWAW) {
				if (elseWAW.has(waw) || !writtenStmts.has(waw)) {
					resultWAW.add(waw);
				}
			}

			const thenWrittenStmts = new Set<ts.Statement>();
			const elseWrittenStmts = new Set<ts.Statement>();
			
			resultWritten.clear();
			for (const [id, stmts] of thenWritten) {
				resultWritten.set(id, stmts);
				for (const stmt of stmts) {
					if (writtenStmts.has(stmt)) {
						thenWrittenStmts.add(stmt);
					}
				}
			}
			
			for (const [id, stmts] of elseWritten) {
				for (const stmt of stmts) {
					if (writtenStmts.has(stmt)) {
						elseWrittenStmts.add(stmt);
					}
				}

				if (resultWritten.has(id)) {
					resultWritten.get(id)!.push(...stmts);
				} else {
					resultWritten.set(id, stmts);
				}
			}

			for (const [, stmts] of resultWritten) {
				for (const stmt of stmts) {
					if (writtenStmts.has(stmt) && (!thenWrittenStmts.has(stmt) || !elseWrittenStmts.has(stmt))) {
						while (stmts.includes(stmt)) {
							stmts.splice(stmts.indexOf(stmt), 1);
						}
					}
				}
			}
		}
		
		for (const stmt of block.statements) {
			if (ts.isExpressionStatement(stmt)
			&& ts.isBinaryExpression(stmt.expression)
			&& stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
				this.nodeAndForEachDescendant(stmt.expression.right, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});

				const id = stmt.expression.left as ts.Identifier;
				const written = resultWritten.get(id);
				if (written) {
					for (const w of written) {
						resultWAW.add(w);
					}
				}
				resultWritten.set(id, [stmt]);
			} else if (ts.isIfStatement(stmt)) {
				this.nodeAndForEachDescendant(stmt.expression, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});

				const [thenWAW, thenWritten] = this.analyseWAWBlock(resultWAW, resultWritten, stmt.thenStatement as ts.Block);
				const [elseWAW, elseWritten] = stmt.elseStatement 
					? this.analyseWAWBlock(resultWAW, resultWritten, stmt.elseStatement as ts.Block)
					: [resultWAW, new Map(resultWritten)];
				merge(thenWAW, thenWritten, elseWAW, elseWritten);
			} else if (ts.isWhileStatement(stmt)) {
				this.nodeAndForEachDescendant(stmt.expression, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});

				const [thenWAW, thenWritten] = this.analyseWAWBlock(resultWAW, resultWritten, stmt.statement as ts.Block);
				const [elseWAW, elseWritten] = [resultWAW, new Map(resultWritten)];
				merge(thenWAW, thenWritten, elseWAW, elseWritten);
				
				this.nodeAndForEachDescendant(stmt.expression, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});

			} else if (ts.isDoStatement(stmt)) {
				const [doWAW, doWritten] = this.analyseWAWBlock(resultWAW, resultWritten, stmt.statement as ts.Block);
				resultWAW.clear();
				for (const w of doWAW) {
					resultWAW.add(w);
				}
				resultWritten.clear();
				for (const [id, w] of doWritten) {
					resultWritten.set(id, w);
				}

				this.nodeAndForEachDescendant(stmt.expression, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});
				
				const [thenWAW, thenWritten] = this.analyseWAWBlock(resultWAW, resultWritten, stmt.statement as ts.Block);
				const [elseWAW, elseWritten] = [resultWAW, new Map(resultWritten)];
				merge(thenWAW, thenWritten, elseWAW, elseWritten);
				
				this.nodeAndForEachDescendant(stmt.expression, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});
			} else {
				this.nodeAndForEachDescendant(stmt, node => {
					if (ts.isIdentifier(node)) {
						resultWritten.delete(node);
					}
				});

			}
		}
			

		return [resultWAW, resultWritten] as const;
	}

	//Inlines literals that have reserved variables
	private inlineSimpleLiteral(file: ts.SourceFile) {
		const literals = new Map<ts.Identifier, ts.NumericLiteral | ts.StringLiteral>();
		const complexRegisters = new Set<ts.Identifier>();

		this.nodeAndForEachDescendant(file, (stmt) => {
			if (ts.isExpressionStatement(stmt)
			&& ts.isBinaryExpression(stmt.expression)
			&& stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
			&& ts.isIdentifier(stmt.expression.left)) {
				const id = stmt.expression.left;
				if (!complexRegisters.has(id) && (ts.isStringLiteral(stmt.expression.right) || ts.isStringLiteral(stmt.expression.right))) {
					literals.set(id, stmt.expression.right);
				} else {
					complexRegisters.add(id);
					literals.delete(id);
				}
			}
		});

		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)
					&& literals.has(stmt.expression.left)) {
						stmts.splice(i, 1);
						i--;
					}
				}

				if (ts.isBlock(node)) {
					node = ts.factory.updateBlock(node, stmts);
				} else {
					node = ts.factory.updateSourceFile(node, stmts);
				}
			}

			if (ts.isIdentifier(node) && literals.has(node)) {
				return literals.get(node)!;
			}

			if (ts.isVariableDeclarationList(node)) {
				node = ts.factory.updateVariableDeclarationList(node, node.declarations.filter(d => !literals.has(d.name as ts.Identifier)));
				return node;
			}

			return ts.visitEachChild(node, visit, ctx);
		});
	}

	//Inlines literals that do not have reserved variables
	private inlineComplexLiteral(file: ts.SourceFile) {
		const literals = new Map<ts.Identifier, ts.NumericLiteral | ts.StringLiteral>();
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				return this.inlineComplexLiteralBlock(node, visit, ctx, literals);
			}

			if (ts.isIdentifier(node) && literals.has(node)) {
				return literals.get(node)!;
			}

			return ts.visitEachChild(node, visit, ctx);
		});
	}
	private inlineComplexLiteralBlock(node: ts.Block | ts.SourceFile, visit: (node: ts.Node) => ts.Node, ctx: ts.TransformationContext, literals: Map<ts.Identifier, ts.NumericLiteral | ts.StringLiteral>) {
		const blockScope = new Set<ts.Identifier>();
		
		const stmts = Array.from(node.statements);
		for (let i = 0; i < stmts.length; i++) {
			const stmt = stmts[i];
			const stmtText = this.debug(stmt);
			if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)) {
				if (ts.isStringLiteral(stmt.expression.right) || ts.isNumericLiteral(stmt.expression.right)) {
					literals.set(stmt.expression.left, stmt.expression.right);
					blockScope.add(stmt.expression.left);
				} else {
					literals.delete(stmt.expression.left);
					stmts[i] = ts.factory.createExpressionStatement(
						ts.factory.updateBinaryExpression(
							stmt.expression, 
							stmt.expression.left, 
							stmt.expression.operatorToken, 
							ts.visitEachChild(stmt.expression.right, visit, ctx)
						));
				}
			} else {
				this.nodeAndForEachDescendant(stmt, n => {
					if (ts.isExpressionStatement(n)
                    && ts.isBinaryExpression(n.expression)
                    && n.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(n.expression.left)
					&& !ts.isStringLiteral(n.expression.right)
					&& !ts.isNumericLiteral(n.expression.right)) {
						literals.delete(n.expression.left);
					}
				});
				stmts[i] = ts.visitEachChild(stmt, visit, ctx);
			}
		}

		for (const id of blockScope) {
			literals.delete(id);
		}

		if (ts.isBlock(node)) {
			node = ts.factory.updateBlock(node, stmts);
		} else {
			node = ts.factory.updateSourceFile(node, stmts);
		}
		return node;
	}

	private deleteDanglingLiteral(file: ts.SourceFile) {
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					if (ts.isExpressionStatement(stmt)
                    && (ts.isStringLiteral(stmt.expression) || ts.isNumericLiteral(stmt.expression))) {
						stmts.splice(i, 1);
						i--;
					}
				}

				if (ts.isBlock(node)) {
					node = ts.factory.updateBlock(node, stmts);
				} else {
					node = ts.factory.updateSourceFile(node, stmts);
				}
			}
			return ts.visitEachChild(node, visit, ctx);
		});
	}

	private nodeAndForEachDescendant(node: ts.Node, visitor: (node: ts.Node) => void) {
		visitor(node);
		ts.forEachChild(node, (n) => this.nodeAndForEachDescendant(n, visitor));
	}

	private transform<T extends ts.Node>(node: T, transformer: (node: ts.Node, visit: (node: ts.Node) => ts.Node, ctx: ts.TransformationContext) => ts.Node) {
		const result= ts.transform(node, [(ctx: ts.TransformationContext) => (node) => 
			ts.visitNode(node, function visit(node): ts.Node {
				return transformer(node, visit, ctx);
			} as ts.Visitor)
		]);
		return result.transformed[0];
	}
	private debug(stmt: ts.Statement) {
		const src = ts.createSourceFile('x.ts', '', ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);

		ts.factory.updateSourceFile(src, [stmt]);
		
		const printer = ts.createPrinter();
		const result = printer.printNode(ts.EmitHint.Unspecified, stmt, src);
		return result;
	}
}