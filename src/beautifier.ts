import ts, { TransformationContext } from 'typescript';

interface LiteralContext {
	parent?: LiteralContext;
	regs: Map<string, ts.Expression>;
}

const NICE_NAMES = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omikron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];

export class Beautifier {
	private literalContext: LiteralContext = {
		regs: new Map(),
	};

	private niceNames = new Map<string, ts.Identifier>();
	private niceEnvNames = new Map<string, ts.Identifier>();

	public beautify(stmt: ts.Statement) {
		return this.transform(stmt, [
			this.removeBlocks,
			this.inlineConditions,
			this.invertIfs,
			this.removeDoubleNot,
			this.removeDoubleParens,
			this.removeEmptyStatements,
			//this.inlineLiterals,
			this.removeGlobalThis,
			this.improveRegisterNames,
		]);
	}

	private transform(stmt: ts.Statement, transformer: ((node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) => ts.Node)[]): ts.Statement {
		const results = ts.transform(stmt, transformer.map(
			t => {
				const cb = t.bind(this);
				return (context): ts.Transformer<ts.Node> => node => 
					ts.visitNode(node, (function visit(this: Beautifier, node): ts.Node {
						return cb(node, visit, context);
					} as ts.Visitor).bind(this));
			}
		));

		return results.transformed[0] as ts.Statement;
	}
	private removeBlocks(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			const stmts = [...node.statements];
			for (let i = 0; i < stmts.length; i++) {
				const current = stmts[i];

				if (ts.isBlock(current)) {
					stmts.splice(i, 1, ...current.statements);
					i--;
				}
			}
			node = ts.factory.updateBlock(node, stmts);
		}
		return ts.visitEachChild(node, visitor, ctx);
	}

	private invertIfs(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			const stmts = [...node.statements];
			for (let i = 0; i < stmts.length; i++) {
				const current = stmts[i];

				if (ts.isIfStatement(current)
				&& (ts.isEmptyStatement(current.thenStatement) 
				|| (ts.isBlock(current.thenStatement) && current.thenStatement.statements.length === 0)
				|| (ts.isPrefixUnaryExpression(current.expression) 
					&& current.expression.operator === ts.SyntaxKind.ExclamationToken
					&& current.elseStatement
					&& !ts.isEmptyStatement(current.elseStatement) 
					&& !(ts.isBlock(current.elseStatement) && current.elseStatement.statements.length === 0)))) {
					stmts.splice(i, 1, ts.factory.updateIfStatement(
						current,
						ts.factory.createLogicalNot(current.expression),
						current.elseStatement ?? ts.factory.createEmptyStatement(),
						current.thenStatement
					));
				}
			}
			node = ts.factory.updateBlock(node, stmts);
		}
		return ts.visitEachChild(node, visitor, ctx);
	}
	

	private inlineConditions(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			const stmts = [...node.statements];
			for (let i = 1; i < stmts.length; i++) {
				const current = stmts[i];
				const prev = stmts[i - 1];

				if (ts.isIfStatement(current)
				&& ts.isPrefixUnaryExpression(current.expression)
				&& current.expression.operator === ts.SyntaxKind.ExclamationToken
				&& ts.isIdentifier(current.expression.operand)
				&& current.expression.operand.text === 'flag'
				
				&& ts.isExpressionStatement(prev)
				&& ts.isBinaryExpression(prev.expression)
				&& prev.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
				&& ts.isIdentifier(prev.expression.left)
				&& prev.expression.left.text === 'flag') {
					stmts.splice(i-1, 2, ts.factory.updateIfStatement(
						current,
						ts.factory.createLogicalNot(
							prev.expression.right
						),
						current.thenStatement,
						current.elseStatement
					));
					i--;
				}
			}
			node = ts.factory.updateBlock(node, stmts);
		}
		return ts.visitEachChild(node, visitor, ctx);
	}

	private removeDoubleNot(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			const stmts = [...node.statements];
			for (let i = 0; i < stmts.length; i++) {
				const current = stmts[i];

				if (ts.isIfStatement(current)
				&& ts.isPrefixUnaryExpression(current.expression)
				&& current.expression.operator === ts.SyntaxKind.ExclamationToken
				&& ts.isPrefixUnaryExpression(current.expression.operand)
				&& current.expression.operand.operator === ts.SyntaxKind.ExclamationToken) {
					stmts.splice(i, 1, ts.factory.updateIfStatement(
						current,
						current.expression.operand.operand,
						current.thenStatement,
						current.elseStatement
					));
					i--;
				}
			}
			node = ts.factory.updateBlock(node, stmts);
		}
		return ts.visitEachChild(node, visitor, ctx);
	}

	private removeDoubleParens(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			const stmts = [...node.statements];
			for (let i = 0; i < stmts.length; i++) {
				const current = stmts[i];

				if (ts.isIfStatement(current)
				&& ts.isParenthesizedExpression(current.expression)) {
					stmts.splice(i, 1, ts.factory.updateIfStatement(
						current,
						current.expression.expression,
						current.thenStatement,
						current.elseStatement
					));
					i--;
				}
			}
			node = ts.factory.updateBlock(node, stmts);
		}
		return ts.visitEachChild(node, visitor, ctx);
	}

	private removeEmptyStatements(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isBlock(node)) {
			node = ts.factory.updateBlock(node,
				node.statements.filter(
					stmt => !ts.isEmptyStatement(stmt) && !(ts.isBlock(stmt) && stmt.statements.length === 0)
				));
		}
		return ts.visitEachChild(node, visitor, ctx);
	}

	private inlineLiterals(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		function getLiteral(ctx: LiteralContext, name: string) {
			while (ctx) {
				if (ctx.regs.has(name)) {
					return ctx.regs.get(name)!;
				}
				ctx = ctx.parent!;
			}
		}

		function deleteLiteral(ctx: LiteralContext, name: string) {
			while (ctx) {
				ctx.regs.delete(name);
				ctx = ctx.parent!;
			}
		}

		if (ts.isIdentifier(node)) {
			const literal = getLiteral(this.literalContext, node.text);
			if (literal) {
				return literal;
			}
		}

		const old = this.literalContext;
		this.literalContext = {
			regs: new Map(),
			parent: old,
		};

		let result: ts.Node;
		if (ts.isBlock(node)) {
			const stmts = [];
			for (const stmt of node.statements) {
				if (ts.isExpressionStatement(stmt)
				&& ts.isBinaryExpression(stmt.expression)
				&& stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
				&& ts.isIdentifier(stmt.expression.left)) {
					stmts.push(ts.factory.updateExpressionStatement(
						stmt,
						ts.factory.updateBinaryExpression(
							stmt.expression,
							stmt.expression.left,
							stmt.expression.operatorToken,
							ts.visitNode(stmt.expression.right, visitor)
						)
					));
					deleteLiteral(this.literalContext, stmt.expression.left.text);
					if ((ts.isLiteralExpression(stmt.expression.right) || ts.isIdentifier(stmt.expression.right))) {
						this.literalContext.regs.set(stmt.expression.left.text, stmt.expression.right);
					}
				} else {
					stmts.push(ts.visitNode(stmt, visitor));
				}
			}
			result = ts.factory.updateBlock(node, stmts);
		} else if (ts.isFunctionExpression(node)) {
			this.literalContext.parent = undefined;
			result = ts.visitEachChild(node, visitor, ctx);
		} else {
			result = ts.visitEachChild(node, visitor, ctx);
		}

		this.literalContext = old;
		return result;
	}

	private removeGlobalThis(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isPropertyAccessExpression(node)
		&& ts.isIdentifier(node.expression)
		&& node.expression.text === 'globalThis') {
			return node.name;
		}

		return ts.visitEachChild(node, visitor, ctx);
	}

	private improveRegisterNames(node: ts.Node, visitor: ts.Visitor, ctx: TransformationContext) {
		if (ts.isIdentifier(node)
		&& this.niceNames.has(node.text)) {
			return this.niceNames.get(node.text)!;
		}

		if (ts.isIdentifier(node)
		&& this.niceEnvNames.has(node.text)) {
			return this.niceEnvNames.get(node.text)!;
		}


		if (ts.isVariableDeclaration(node)
		&& ts.isIdentifier(node.name)
		&& node.name.text.startsWith('__reg__')) {
			const name = node.name.text;
			const number = Number(name.substring(name.lastIndexOf('__') + 2));
			if (!Number.isNaN(number)) {
				const newName = NICE_NAMES[number] ?? ('r' + number);
				const newNode = ts.factory.createIdentifier(newName); //ts.factory.createUniqueName(newName, ts.GeneratedIdentifierFlags.Optimistic);
				this.niceNames.set(name, newNode);
				return ts.factory.updateVariableDeclaration(node, newNode, node.exclamationToken, node.type, node.initializer);
			}
			return node;
		} else if (ts.isVariableDeclaration(node)
		&& ts.isIdentifier(node.name)
		&& node.name.text.startsWith('__envreg__')) {
			const name = node.name.text;
			const number = Number(name.substring(name.lastIndexOf('__') + 2));
			if (!Number.isNaN(number)) {
				const newName = (NICE_NAMES[number] ?? ('e' + number)) + '_';
				const newNode = ts.factory.createIdentifier(newName); //ts.factory.createUniqueName(newName, ts.GeneratedIdentifierFlags.Optimistic);
				this.niceEnvNames.set(name, newNode);
				return ts.factory.updateVariableDeclaration(node, newNode, node.exclamationToken, node.type, node.initializer);
			}
			return node;
		} else if (ts.isFunctionExpression(node)) {
			const saved = this.niceNames;
			this.niceNames = new Map();
			const result = ts.visitEachChild(node, visitor, ctx);
			this.niceNames = saved;
			return result;
		} else {
			return ts.visitEachChild(node, visitor, ctx);
		}
	}
}