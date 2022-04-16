import ts from 'typescript';

function debug(node: ts.Node, file: ts.SourceFile) {
	return ts.createPrinter().printNode(ts.EmitHint.Unspecified, node, file);
}

export interface DependencyNode {
	code: string;
	node: ts.Statement;
	dependsOn: Record<string, DependencyNode[]>;
	affects: DependencyNode[];
}

export class DependencyGraph {
	public readonly nodes = new Map<ts.Statement, DependencyNode>();

	public constructor(private readonly file: ts.SourceFile) {
		this.analyse(file, new Map());

		for (const [_, node] of this.nodes) {
			console.log(debug(node.node, file).split('\n')[0]);
			console.log('  affects: ' + node.affects.map(a => debug(a.node, file).split('\n')[0]).join(' | '));
			console.log('  depends:');
			for (const [d, val] of Object.entries(node.dependsOn)) {
				console.log('    ' + d + ': ' + val.map(a => debug(a.node, file).split('\n')[0]).join(' | '));
			}
		}
	}

	private analyse(block: ts.SourceFile | ts.Block, identifiers: Map<ts.Identifier, DependencyNode[]>) {
		const markDependency = (node: ts.Node, newNode: DependencyNode, prefix = '') => {
			this.nodeAndForEachDescendant(node, (n, path) => {
				if (ts.isIdentifier(n) && identifiers.has(n) && 'autoGenerateId' in n) {
					for (const parent of identifiers.get(n)!) {
						if (parent.affects.every(a => a.node !== newNode.node)) {
							parent.affects.push(newNode);
						}
					}
					newNode.dependsOn[path] = [...identifiers.get(n)!];
				}
			}, prefix);
		};

		const mergeDependencies = (oldIds: Map<ts.Identifier, DependencyNode[]>) => {
			for (const [id, nodes] of oldIds) {
				const newNodes = [...identifiers.get(id) ?? []];
				for (const node of nodes) {
					if (newNodes.every(n => n.node !== node.node)) {
						newNodes.push(node);
					}
				}
				identifiers.set(id, newNodes);
			}
		};

		for (const stmt of block.statements) {
			const newNode: DependencyNode = this.nodes.get(stmt) ?? {
				code: debug(stmt, this.file),
				node: stmt,
				affects: [],
				dependsOn: {},
			};

			if (ts.isExpressionStatement(stmt)
			&& ts.isBinaryExpression(stmt.expression)
			&& stmt.expression.operatorToken.kind === ts.SyntaxKind.FirstAssignment) {
				markDependency(stmt.expression.right, newNode, '.expression.right');

				const id = stmt.expression.left as ts.Identifier;
				identifiers.set(id, [newNode]);
			} else if (ts.isIfStatement(stmt)) {
				markDependency(stmt.expression, newNode, '.expression');

				const oldIds = new Map(identifiers);
				this.analyse(stmt.thenStatement as ts.Block, identifiers);
				if (stmt.elseStatement) {
					this.analyse(stmt.elseStatement as ts.Block, oldIds);
				}
				mergeDependencies(oldIds);
			} else if (ts.isWhileStatement(stmt)) {
				markDependency(stmt.expression, newNode, '.expression');

				const oldIds = new Map(identifiers);
				this.analyse(stmt.statement as ts.Block, identifiers);
				mergeDependencies(oldIds);

				const oldIds2 = new Map(identifiers);
				this.analyse(stmt.statement as ts.Block, identifiers);
				mergeDependencies(oldIds2);

				markDependency(stmt.expression, newNode, '.expression');
			} else if (ts.isDoStatement(stmt)) {
				this.analyse(stmt.statement as ts.Block, identifiers);
				markDependency(stmt.expression, newNode, '.expression');

				const oldIds = new Map(identifiers);
				this.analyse(stmt.statement as ts.Block, identifiers);
				mergeDependencies(oldIds);
				
				markDependency(stmt.expression, newNode, '.expression');
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

	private nodeAndForEachDescendant(node: ts.Node, visitor: (node: ts.Node, path: string) => void, path = '') {
		visitor(node, path);
		
		const visitCount = new Map<ts.Node | ts.NodeArray<ts.Node>, number>();
		
		ts.forEachChild(
			node, 
			(n) => this.nodeAndForEachDescendant(n, visitor, getPath(n)),
			nodes => {
				const base = getPath(nodes) + '.';
				for (let i = 0; i < nodes.length; i++) {
					this.nodeAndForEachDescendant(nodes[i], visitor, base + i);
				}
			});

		function getPath(child: ts.Node | ts.NodeArray<ts.Node>) {
			const paths = Object.keys(node).filter((key) => node[key as keyof ts.Node] === child);
			if (paths.length === 0) {
				throw new Error('could not resolve path');
			}
			let index = 0;
			if (paths.length > 1) {
				index = visitCount.get(child) ?? 0;
				visitCount.set(child, index + 1);
			}
			return path + '.' + paths[index];
		}
	}

	public inlineNode(from: ts.Node, to: ts.Node, path: string): ts.Node {
		this.assign(to, path, from);
		return to;
	}

	public replace(from: ts.Statement, to: ts.Statement, dependsOn?: Record<string, DependencyNode[]>, affects?: DependencyNode[]) {
		const node = this.nodes.get(from)!;
		node.node = to;
		node.dependsOn = dependsOn ?? node.dependsOn;
		node.affects = affects ?? node.affects;
		this.nodes.set(to, node);
	}

	private assign(obj: unknown, path: string, value: unknown) {
		let lastObj = obj;
		let lastPath = path;
		while (path.length > 0) {
			lastObj = obj;
			lastPath = path;
			const nextDot = path.indexOf('.', 1);
			const nextPath = path.substring(1, nextDot === -1 ? undefined : nextDot);
			obj = (obj as Record<string, unknown>)[nextPath];
			path = nextDot === -1 ? '' : path.substring(nextDot);
		}
		(lastObj as Record<string, unknown>)[lastPath.substring(1)] = value;
	}
}