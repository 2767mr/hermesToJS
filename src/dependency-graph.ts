import ts from 'typescript';

function debug(node: ts.Node, file: ts.SourceFile) {
	return ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, file);
}

export interface DependencyNode {
	code: string;
	node: ts.Statement;
	dependsOn: DependencyNode[][];
	affects: DependencyNode[];
}

export class DependencyGraph {
	public readonly nodes = new Map<ts.Statement, DependencyNode>();

	public constructor(private readonly file: ts.SourceFile) {
		this.analyse(file, new Map());

		for (const [_, node] of this.nodes) {
			console.log(debug(node.node, file));
			console.log('  affects: ' + node.affects.map(a => debug(a.node, file)).join(' | '));
			console.log('  depends: ' + node.dependsOn.flatMap(ds => ds.map(d => debug(d.node, file))).join(' | '));
		}
	}

	private analyse(block: ts.SourceFile | ts.Block, identifiers: Map<ts.Identifier, DependencyNode[]>) {
		const markDependency = (node: ts.Node, newNode: DependencyNode) => {
			this.nodeAndForEachDescendant(node, n => {
				if (ts.isIdentifier(n) && identifiers.has(n) && 'autoGenerateId' in n) {
					for (const parent of identifiers.get(n)!) {
						if (!parent.affects.includes(newNode)) {
							parent.affects.push(newNode);
						}
					}
					newNode.dependsOn.push(identifiers.get(n)!);
				}
			});
		};

		const mergeDependencies = (oldIds: Map<ts.Identifier, DependencyNode[]>) => {
			for (const [id, nodes] of oldIds) {
				const newNodes = identifiers.get(id) ?? [];
				for (const node of nodes) {
					if (!newNodes.includes(node)) {
						newNodes.push(node);
					}
				}
				identifiers.set(id, newNodes);
			}
		};

		for (const stmt of block.statements) {
			const newNode: DependencyNode = {
				code: debug(stmt, this.file),
				node: stmt,
				affects: [],
				dependsOn: [],
			};

			if (ts.isExpressionStatement(stmt)
			&& ts.isBinaryExpression(stmt.expression)
			&& stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
				markDependency(stmt.expression.right, newNode);

				const id = stmt.expression.left as ts.Identifier;
				identifiers.set(id, [newNode]);
			} else if (ts.isIfStatement(stmt)) {
				markDependency(stmt.expression, newNode);

				const oldIds = new Map(identifiers);
				this.analyse(stmt.thenStatement as ts.Block, identifiers);
				if (stmt.elseStatement) {
					this.analyse(stmt.thenStatement as ts.Block, oldIds);
				}
				mergeDependencies(oldIds);
			} else if (ts.isWhileStatement(stmt)) {
				markDependency(stmt.expression, newNode);

				const oldIds = new Map(identifiers);
				this.analyse(stmt.statement as ts.Block, identifiers);
				mergeDependencies(oldIds);

				markDependency(stmt.expression, newNode);
			} else if (ts.isDoStatement(stmt)) {
				this.analyse(stmt.statement as ts.Block, identifiers);
				markDependency(stmt.expression, newNode);

				const oldIds = new Map(identifiers);
				this.analyse(stmt.statement as ts.Block, identifiers);
				mergeDependencies(oldIds);
				
				markDependency(stmt.expression, newNode);
			} else if (ts.isVariableStatement(stmt)) {
				for (const v of stmt.declarationList.declarations) {
					identifiers.set(v.name as ts.Identifier, [newNode]);
				}
			} else {
				markDependency(stmt, newNode);
			}

			this.nodes.set(stmt, newNode);
		}
			
	}

	private nodeAndForEachDescendant(node: ts.Node, visitor: (node: ts.Node) => void) {
		visitor(node);
		ts.forEachChild(node, (n) => this.nodeAndForEachDescendant(n, visitor));
	}
}