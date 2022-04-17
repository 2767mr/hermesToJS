import ts from 'typescript';
import { DependencyGraph } from './dependency-graph';


export class Optimizer {
	public optimize(file: ts.SourceFile) {		
		ts.createPrinter().printFile(file);

		file = this.inlineGlobal(file);
		const graph = new DependencyGraph(file);
		file = this.inlineLiteral(file, graph);
		file = this.inlineCall(file, graph);
		file = this.removeWAW(file, graph);
		file = this.inlinePreceding(file, graph);
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

	
	//Inlines literals that have reserved variables
	private inlineLiteral(file: ts.SourceFile, graph: DependencyGraph) {
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					const code = this.debug(stmt);
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)
					&& (ts.isStringLiteral(stmt.expression.right) || ts.isNumericLiteral(stmt.expression.right))) {
						const from = graph.nodes.get(stmt)!;
						if (!from) {
							console.warn('Stmt not in nodes: ' + code);
							continue;
						}
						for (const to of from.affects) {
							const [path] = Object.entries(to.dependsOn).find(([, val]) => val.includes(from))!;
							if (to.dependsOn[path].length === 1) {
								graph.inlineNode(from, '.expression.right', to, path);
								from.affects.splice(from.affects.indexOf(to), 1);
							}
						}
						if (from.affects.length === 0) {
							stmts.splice(i, 1);
							i--;
						}
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
	
	private removeWAW(file: ts.SourceFile, graph: DependencyGraph) {
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					const code = this.debug(stmt);
					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)) {
						const from = graph.nodes.get(stmt)!;
						if (!from) {
							console.warn('Stmt not in nodes: ' + code);
							continue;
						}
						if (from.affects.length === 0) {
							const replaced = ts.factory.createExpressionStatement(stmt.expression.right);
							stmts[i] = replaced;
							graph.replace(stmt, replaced);
						}
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

	private inlineCall(file: ts.SourceFile, graph: DependencyGraph) {
		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					const code = this.debug(stmt);

					//Is call expression
					if (ts.isExpressionStatement(stmt)
						&& ts.isBinaryExpression(stmt.expression)
						&& stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
						&& ts.isIdentifier(stmt.expression.left)
						&& ts.isCallExpression(stmt.expression.right)
						&& ts.isPropertyAccessExpression(stmt.expression.right.expression)
						&& ts.isIdentifier(stmt.expression.right.expression.expression)
						&& ts.isIdentifier(stmt.expression.right.expression.name)
						&& stmt.expression.right.expression.name.text === 'call'
						&& ts.isIdentifier(stmt.expression.right.arguments[0])) {

						const node = graph.nodes.get(stmt)!;
						const callerDeps = node.dependsOn['.expression.right.expression.expression'];
						const contextDeps = node.dependsOn['.expression.right.arguments.0'];

						//Is only used once
						if (callerDeps.length === 1 
							&& contextDeps.length === 1
							&& callerDeps[0].affects.length === 1
							&& contextDeps[0].affects.length === 2
							&& contextDeps[0].affects[0] === callerDeps[0]
							//&& contextDeps[0].affects[1] === node //always true
						) {
							const contextIndex = stmts.indexOf(contextDeps[0].node);
							const callerIndex = stmts.indexOf(callerDeps[0].node);

							//Is in same block and sequential
							if (contextIndex !== -1
								&& callerIndex !== -1
								&& callerIndex === contextIndex + 1) {
									
								//We can only inline it if there are no other dependencies
								//TODO: it should be possible to replax this a bit
								let noDeps = true;
								for (let j = 1; j < stmt.expression.right.arguments.length; j++) {
									if (node.dependsOn['.expression.right.arguments.' + j]?.length) {
										noDeps = false;
										break;
									}
								}

								if (noDeps) {
									graph.inlineNode(contextDeps[0], '.expression.right', callerDeps[0], Object.keys(callerDeps[0].dependsOn)[0]);
									const inlined = graph.inlineNode(callerDeps[0], '.expression.right', node, '.expression.right.expression');
									((inlined as any).expression.right.arguments as ts.Node[]).splice(0, 1);
									for (let j = 1; j < stmt.expression.right.arguments.length; j++) {
										node.dependsOn['.expression.right.arguments.' + (j - 1)] = node.dependsOn['.expression.right.arguments.' + j]; 
									}
									delete node.dependsOn['.expression.right.arguments.' + (stmt.expression.right.arguments.length - 1)];
									stmts[i] = inlined as ts.Statement;
									stmts.splice(contextIndex, 2);
									i -= 2;
								}
							}
						}
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

	private inlinePreceding(file: ts.SourceFile, graph: DependencyGraph) {
		function getLastEvaluationDepenency(node: ts.Node): ts.Identifier | undefined {
			if (ts.isIdentifier(node)) {
				return 'autoGenerateId' in node ? node : undefined;
			}
			if (ts.isExpressionStatement(node)) {
				return getLastEvaluationDepenency(node.expression);
			}
			if (ts.isBinaryExpression(node)) {
				if (node.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
					if (!ts.isIdentifier(node.left)) {
						const result = getLastEvaluationDepenency(node.left);
						if (result) {
							return result;
						}
					}
					return getLastEvaluationDepenency(node.right);
				} else {
					const result = getLastEvaluationDepenency(node.right);
					if (result) {
						return result;
					}
					return getLastEvaluationDepenency(node.left);
				}
			}
			if (ts.isPropertyAccessChain(node)) {
				const result = getLastEvaluationDepenency(node.expression);
				if (result) {
					return result;
				}
				return getLastEvaluationDepenency(node.name);
			}
			if (ts.isCallExpression(node)) {
				for (let i = node.arguments.length - 1; i >= 0; i--) {
					const result = getLastEvaluationDepenency(node.arguments[i]);
					if (result) {
						return result;
					}
				}
				return getLastEvaluationDepenency(node.expression);
			}
		}


		return this.transform(file, (node, visit, ctx) => {
			if (ts.isBlock(node) || ts.isSourceFile(node)) {
				const stmts = Array.from(node.statements);
				for (let i = 0; i < stmts.length; i++) {
					const stmt = stmts[i];
					const lastStmt = stmts[i - 1];
					const code = this.debug(stmt);

					if (Object.values(graph.nodes.get(stmt)?.dependsOn ?? {}).every(d => d.length == 0)) {
						continue;
					}
					const lastDep = getLastEvaluationDepenency(stmt);
					if (lastDep) {
						if (lastStmt 
							&& ts.isExpressionStatement(lastStmt)
							&& ts.isBinaryExpression(lastStmt.expression)
							&& lastStmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
							&& ts.isIdentifier(lastStmt.expression.left)
							&& lastStmt.expression.left === lastDep) {
							continue;
						}
					}

					if (ts.isExpressionStatement(stmt)
                    && ts.isBinaryExpression(stmt.expression)
                    && stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment
					&& ts.isIdentifier(stmt.expression.left)) {
						// const from = graph.nodes.get(stmt)!;
						
						// if (from.affects.length === 0) {
						// 	const replaced = ts.factory.createExpressionStatement(stmt.expression.right);
						// 	stmts[i] = replaced;
						// 	graph.replace(stmt, replaced);
						// }
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