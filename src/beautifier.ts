import ts, { TransformationContext } from 'typescript';

export class Beautifier {
	public beautify(stmt: ts.Statement) {
		return this.transform(stmt, [
			this.removeBlocks,
			this.inlineConditions,
			this.invertIfs,
			this.removeDoubleNot,
			this.removeDoubleParens,
			this.removeEmptyStatements
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
}