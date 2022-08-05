import ts from 'typescript';

import { CodeBlock, ControlflowBuilder, ControlflowNode } from './controlflow';
import { Disassembler, Instruction } from './disasm';
import { FunctionHeader, HBCHeader } from './parser';
import { SerializedLiteralParser } from './slp';

interface Environment {
	parent: Environment;

	vars: ts.Identifier[];
	origin: ts.Statement;
}

interface Context {
	params: ts.Identifier[];
	regs: ts.Identifier[];
	env: Environment;

	envs: Environment[];
	queue: [Scope, ControlflowNode, ts.Statement][];
	completed: Map<ts.Statement, ts.Statement>;
}

interface Scope {
	parent: Scope;
	context: Context;
	envRegs: Environment[];
}

export class Decompiler {
	private static readonly warnings = new Set<string>();
	private readonly ctrlFlowBuilder = new ControlflowBuilder(this.disassembler);
	private count = 0;

	constructor(
		private readonly disassembler: Disassembler,
		private readonly header: HBCHeader,
	) {
		
	}

	public decompile() {
		const topEnv: Environment = {vars: [], parent: {} as Environment, origin: ts.factory.createEmptyStatement()};
		topEnv.parent = topEnv;
		const func = this.decompileFunction({
			params: [],
			regs: [],
			env: topEnv,
			envs: [],
			queue: [],
			completed: new Map(),
		}, this.header.functionHeaders[0]);
		for (const warning of Decompiler.warnings) {
			console.warn('Opcode not implemented: ' + warning);
		}
		return ts.factory.createExpressionStatement(
			ts.factory.createCallExpression(func, [], [])
		);
	}

	private decompileFunction(ctx: Context, fHeader: FunctionHeader) {
		this.count++;

		if (this.count % 100 == 0) {
			console.log(`${this.count}/${this.header.functionHeaders.length} (${100 * this.count / this.header.functionHeaders.length}%)`);
		}

		const controlflow = this.ctrlFlowBuilder.buildControlFlow(fHeader);

		for (let i = 0; i < fHeader.paramCount - 1; i++) {
			ctx.params.push(ts.factory.createIdentifier('p' + i));
		}

		const bodyNode = this.decompileNodes(ctx, controlflow);

		const vars: ts.VariableDeclaration[] = [
			ts.factory.createVariableDeclaration('flag'),
			ts.factory.createVariableDeclaration('value'),
		];

		for (const reg of ctx.regs) {
			if (reg) {
				vars.push(ts.factory.createVariableDeclaration(reg));
			}
		}

		const body = ts.factory.createBlock([
			ts.factory.createVariableStatement([], 
				ts.factory.createVariableDeclarationList(vars)), 
			bodyNode
		], true);

		const func = ts.factory.createFunctionExpression(
			undefined, 
			undefined, 
			this.disassembler.getName(fHeader) || undefined,
			undefined,
			ctx.params.map(p => ts.factory.createParameterDeclaration(
				undefined,
				undefined,
				undefined,
				p
			)),
			undefined,
			body);
		const result = ts.transform(func, [
			(context): ts.Transformer<ts.Node> => 
				node => 
					ts.visitNode(node, (function visit(this: Decompiler, node): ts.Node {
						if (ts.isFunctionExpression(node) && node !== func) {
							return node;
						}

						const env = ctx.envs.find(e => e.origin === node);
						if (env) {
							if (env.vars.length === 0) {
								const result = ts.factory.createEmptyStatement();
								ts.addSyntheticTrailingComment(result, ts.SyntaxKind.SingleLineCommentTrivia, 'Empty environment');
								return result;
							}

							const vars: ts.VariableDeclaration[] = [];
							for (const v of env.vars) {
								if (v) {
									vars.push(ts.factory.createVariableDeclaration(v));
								}
							}

							return ts.factory.createVariableStatement(undefined, 
								ts.factory.createVariableDeclarationList(vars));
						}

						return ts.visitEachChild(node, visit.bind(this), context);
					} as ts.Visitor).bind(this))
		]).transformed[0] as ts.FunctionExpression;

		// ts.addSyntheticLeadingComment(result, ts.SyntaxKind.MultiLineCommentTrivia, 'function ' + this.header.functionHeaders.indexOf(fHeader));
		
		// this.printTSNode(ts.factory.createExpressionStatement(result));
		return result;
	}

	private decompileNodes(ctx: Context, node: ControlflowNode) {
		const topScope: Scope = {
			parent: {} as Scope,
			context: ctx,
			envRegs: []
		};
		topScope.parent = topScope;

		const key = ts.factory.createEmptyStatement();
		ctx.queue.push([topScope, node, key]);

		const visited = new Set<ControlflowNode>();
		
		while (ctx.queue.length > 0) {
			const [scope, nextNode, scheduled] = ctx.queue.shift()!;

			if (visited.has(nextNode)) {
				continue;
			}
			visited.add(nextNode);

			const result = this.decompileNode(scope, nextNode);
			ctx.completed.set(scheduled, result);
		}
		
		return ts.transform(ctx.completed.get(key)!, [
			(context): ts.Transformer<ts.Node> => 
				node => 
					ts.visitNode(node, (function visit(this: Decompiler, node): ts.Node {
						if (ctx.completed.has(node as ts.Statement)) {
							node = ctx.completed.get(node as ts.Statement)!;
						}
	
						return ts.visitEachChild(node, visit.bind(this), context);
					} as ts.Visitor).bind(this)),
			(context): ts.Transformer<ts.Node> => 
				node => 
					ts.visitNode(node, (function visit(this: Decompiler, node): ts.Node {
						if (ts.isBlock(node)) {
							node = ts.factory.updateBlock(node, node.statements.filter(s => !ts.isEmptyStatement(s)));
						}
			
						return ts.visitEachChild(node, visit.bind(this), context);
					} as ts.Visitor).bind(this))
		]).transformed[0] as ts.Block | ts.Statement;
	}

	private schedule(scope: Scope, node: ControlflowNode): ts.Statement {
		return this.decompileNode(
			{parent: scope, context: scope.context, envRegs: []},
			node,
		);
		const result = ts.factory.createExpressionStatement(ts.factory.createUniqueName('scheduled'));

		scope.context.queue.push([
			{parent: scope, context: scope.context, envRegs: []},
			node,
			result
		]);

		return result;
	}

	private decompileNode(scope: Scope, node: ControlflowNode): ts.Block | ts.Statement {
		switch (node.type) {
		case 'c': {
			const code = this.decompileBlock(scope.context, scope, node.code);
			if (node.isLoop) {
				if (node.after) {
					return ts.factory.createBlock([
						...code.statements,
						this.schedule(scope, node.after)!
					], true);
				} else {
					return code;
				}
			}

			const ifNode = node.then.type !== 'r' || !node.then.empty 
				? ts.factory.createIfStatement(
					ts.factory.createLogicalNot(
						ts.factory.createIdentifier('flag')
					),
					this.schedule(scope, node.else)!,
					this.schedule(scope, node.then)!
				)
				: ts.factory.createIfStatement(
					ts.factory.createLogicalNot(
						ts.factory.createIdentifier('flag')
					),
					this.schedule(scope, node.else)!
				);
			
				
			if (node.after) {
				return ts.factory.createBlock([
					...code.statements,
					ifNode,
					this.schedule(scope, node.after)!
				], true);
			} else {
				return ts.factory.createBlock([
					...code.statements,
					ifNode
				], true);
			}
		}
		case 'j': {
			const code = this.decompileBlock(scope.context, scope, node.code);
			const last = node.code.insts[node.code.insts.length - 1];
			if (last.opcode !== 'Ret' && !node.isLoop) {
				const target = this.schedule(scope, node.target)!;

				return ts.factory.createBlock([
					...code.statements,
					...(ts.isBlock(target) ? target.statements : [target])
				], true);
			}
			return ts.factory.createBlock([
				...code.statements,
			], true);
		}
		case 'r': {
			if (!node.empty) {
				return ts.factory.createReturnStatement();
			}
			return ts.factory.createEmptyStatement();
		}
		case 's': {
			const code = this.decompileBlock(scope.context, scope, node.code);
			const clauses: ts.CaseClause[] = [];

			const last = node.code.insts[node.code.insts.length - 1];
			const start = last.operands[3].value as number;
			const end = last.operands[4].value as number;
			const count = end - start + 1;
			for (let i = 0; i < count; i++) {
				const block = node.blocks[i];
				const clause = ts.factory.createCaseClause(
					ts.factory.createNumericLiteral(i + start),
					[
						this.schedule(scope, block)!,
						ts.factory.createBreakStatement(),
					]
				);

				clauses.push(clause);
			}

			clauses.push(
				ts.factory.createDefaultClause(
					[
						this.schedule(scope, node.default)!,
						ts.factory.createBreakStatement(),
					]
				) as unknown as ts.CaseClause
			);

			const switchNode = ts.factory.createSwitchStatement(
				ts.factory.createIdentifier('value'),
				ts.factory.createCaseBlock(
					clauses
				)
			);

			const after = node.after ? this.schedule(scope, node.after)! : ts.factory.createEmptyStatement();

			return ts.factory.createBlock([
				...code.statements,
				switchNode,
				after,
			], true);
		}
		case 'l': {
			return ts.factory.createBlock([
				ts.factory.createDoStatement(
					this.schedule(scope, node.body)!,
					ts.factory.createIdentifier('flag')
				),
				this.schedule(scope, node.after)!
			], true);
		}
		}

	}

	private decompileBlock(ctx: Context, scope: Scope, block: CodeBlock) {
		const stmts: ts.Statement[] = [];
		for (const inst of block.insts) {
			const node = this.decompileInstruction(ctx, scope, inst);
			if (!ts.isEmptyStatement(node)) {
				stmts.push(node);
			}
		}
		return ts.factory.createBlock(stmts, true);
	}

	private decompileInstruction(ctx: Context, scope: Scope, inst: Instruction): ts.Statement {
		switch (inst.opcode) {
		//Load const
		case 'LoadConstString':
		case 'LoadConstStringLongIndex': //TODO: check
			return this.assign(ctx, inst,
				ts.factory.createStringLiteral(inst.operands[1].value as string));
		case 'LoadConstZero':
			return this.assign(ctx, inst,  
				ts.factory.createNumericLiteral(0));
		case 'LoadConstUndefined':
			return this.assign(ctx, inst,  
				ts.factory.createIdentifier('undefined'));
		case 'LoadConstNull':
			return this.assign(ctx, inst,  
				ts.factory.createNull());
		case 'LoadConstFalse':
			return this.assign(ctx, inst,  
				ts.factory.createFalse());
		case 'LoadConstTrue':
			return this.assign(ctx, inst,  
				ts.factory.createTrue());
		case 'LoadConstUInt8':
		case 'LoadConstInt':
		case 'LoadConstDouble':
			return this.assign(ctx, inst,
				ts.factory.createNumericLiteral(inst.operands[1].value as number));
						
		//Unconditional
		case 'Jmp':
		case 'JmpLong':
			return ts.factory.createEmptyStatement();
		case 'Ret':
			return ts.factory.createReturnStatement(this.getRegister(ctx, inst.operands[0].value as number));
	
		//Conditional
		case 'JEqual':
		case 'JEqualLong':
			return this.condition(ts.factory.createEquality(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JGreater':
		case 'JGreaterLong':
		case 'JGreaterN':
		case 'JGreaterNLong':
			return this.condition(ts.factory.createGreaterThan(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JGreaterEqual':
		case 'JGreaterEqualLong':
		case 'JGreaterEqualN':
		case 'JGreaterEqualNLong':
			return this.condition(ts.factory.createGreaterThanEquals(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JLess':
		case 'JLessEqual':
		case 'JLessLong':
		case 'JLessN':
		case 'JLessNLong':
			return this.condition(ts.factory.createLessThan(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JLessEqualLong':
		case 'JLessEqualN':
		case 'JLessEqualNLong':
			return this.condition(ts.factory.createLessThanEquals(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JStrictEqual':
		case 'JStrictEqualLong':
			return this.condition(ts.factory.createStrictEquality(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JNotEqual':
		case 'JNotEqualLong':
			return this.condition(ts.factory.createInequality(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JNotGreater':
		case 'JNotGreaterLong':
		case 'JNotGreaterN':
		case 'JNotGreaterNLong':
			return this.conditionNot(ts.factory.createGreaterThan(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JNotGreaterEqual':
		case 'JNotGreaterEqualLong':
		case 'JNotGreaterEqualN':
		case 'JNotGreaterEqualNLong':
			return this.conditionNot(ts.factory.createGreaterThanEquals(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JNotLess':
		case 'JNotLessLong':
		case 'JNotLessN':
		case 'JNotLessNLong':
			return this.conditionNot(ts.factory.createLessThan(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JNotLessEqual':
		case 'JNotLessEqualLong':
		case 'JNotLessEqualN':
		case 'JNotLessEqualNLong':
			return this.conditionNot(ts.factory.createLessThanEquals(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JStrictNotEqual':
		case 'JStrictNotEqualLong':
			return this.condition(ts.factory.createStrictInequality(
				this.getRegister(ctx, inst.operands[1].value as number),
				this.getRegister(ctx, inst.operands[2].value as number),
			));
		case 'JmpFalse':
		case 'JmpFalseLong':
			return this.conditionNot(
				this.getRegister(ctx, inst.operands[1].value as number)
			);
		case 'JmpTrue':
		case 'JmpTrueLong':
			return this.condition(
				this.getRegister(ctx, inst.operands[1].value as number)
			);
		case 'JmpUndefined':
		case 'JmpUndefinedLong':
			return this.condition(ts.factory.createStrictEquality(
				this.getRegister(ctx, inst.operands[1].value as number),
				ts.factory.createVoidZero(),
			));
		case 'SwitchImm':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createIdentifier('value'),
					this.getRegister(ctx, inst.operands[0].value as number)
				)
			);

		//Calls
		case 'Call1':
			return this.assign(ctx, inst,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						'call'
					),
					undefined,
					[
						this.getRegister(ctx, inst.operands[2].value as number),
					]
				)
			);
		case 'Call2':
			return this.assign(ctx, inst,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						'call'
					),
					undefined,
					[
						this.getRegister(ctx, inst.operands[2].value as number),
						this.getRegister(ctx, inst.operands[3].value as number),
					]
				)
			);
		case 'Call3':
			return this.assign(ctx, inst,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						'call'
					),
					undefined,
					[
						this.getRegister(ctx, inst.operands[2].value as number),
						this.getRegister(ctx, inst.operands[3].value as number),
						this.getRegister(ctx, inst.operands[4].value as number),
					]
				)
			);
		case 'Call4':
			return this.assign(ctx, inst,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						'call'
					),
					undefined,
					[
						this.getRegister(ctx, inst.operands[2].value as number),
						this.getRegister(ctx, inst.operands[3].value as number),
						this.getRegister(ctx, inst.operands[4].value as number),
						this.getRegister(ctx, inst.operands[5].value as number),
					]
				)
			);
			
		//Accessors
		case 'PutById':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[0].value as number),
						inst.operands[3].value as string
					),
					this.getRegister(ctx, inst.operands[1].value as number)
				)
			);
		case 'PutNewOwnById':
		case 'PutNewOwnByIdLong':
		case 'PutNewOwnByIdShort':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[0].value as number),
							inst.operands[2].value as string
					),
					this.getRegister(ctx, inst.operands[1].value as number)
				)
			);
		case 'GetById':
		case 'TryGetById':
		case 'GetByIdShort':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						inst.operands[3].value as string
					),
				)
			);
			
		case 'PutOwnByIndex':
		case 'PutOwnByIndexL':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createElementAccessExpression(
						this.getRegister(ctx, 0),
						inst.operands[2].value as number
					),
					this.getRegister(ctx, 1),
				)
			);
		case 'PutByVal':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createElementAccessExpression(
						this.getRegister(ctx, inst.operands[0].value as number),
						this.getRegister(ctx, inst.operands[1].value as number)
					),
					this.getRegister(ctx, inst.operands[2].value as number)
				)
			);
		case 'GetByVal':
			return this.assign(ctx, inst,
				ts.factory.createElementAccessExpression(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);

		//Create
		case 'NewObject':
			return this.assign(ctx, inst, 
				ts.factory.createObjectLiteralExpression());
		case 'NewObjectWithBuffer':
		case 'NewObjectWithBufferLong': {
			//const preallocationSizeHint = inst.operands[1].value as number;
			const staticElements = inst.operands[2].value as number;
			const keyIndex = inst.operands[3].value as number;
			const valueIndex = inst.operands[4].value as number;
	
			const keys = SerializedLiteralParser.parseN(this.header.objKeyValuesRaw, this.header, keyIndex, staticElements);
			const values = SerializedLiteralParser.parseN(this.header.objValueValuesRaw, this.header, valueIndex, staticElements);
			const properties: ts.ObjectLiteralElementLike[] =
				keys.map((key, index) => ts.factory.createPropertyAssignment('' + key, this.toLiteral(values[index])));
			

			return this.assign(ctx, inst, 
				ts.factory.createObjectLiteralExpression(properties, staticElements > 1)
			);
		}
		case 'NewArrayWithBuffer':
		case 'NewArrayWithBufferLong': {
			//const preallocationSizeHint = inst.operands[1].value as number;
			const staticElements = inst.operands[2].value as number;
			const index = inst.operands[3].value as number;
	
			const elements: ts.Expression[] = 
				SerializedLiteralParser.parseN(this.header.arrayValuesRaw, this.header, index, staticElements)
					.map(value => this.toLiteral(value));
	
			return this.assign(ctx, inst, 
				ts.factory.createArrayLiteralExpression(elements)
			);
		}
		case 'NewArray':
			return this.assign(ctx, inst, ts.factory.createArrayLiteralExpression());

		//Other
		case 'DelById':
			return this.assign(ctx, inst,
				ts.factory.createDeleteExpression(
					ts.factory.createPropertyAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						inst.operands[2].value as string
					)
				)
			);
			
		case 'DelByVal':
			return this.assign(ctx, inst,
				ts.factory.createDeleteExpression(
					ts.factory.createElementAccessExpression(
						this.getRegister(ctx, inst.operands[1].value as number),
						this.getRegister(ctx, inst.operands[2].value as number)
					)
				)
			);

		case 'PutOwnGetterSetterByVal':
			return ts.factory.createExpressionStatement(
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						ts.factory.createIdentifier('Object'),
						'defineProperty'
					),
					undefined,
					[
						this.getRegister(ctx, 0),
						this.getRegister(ctx, 1),
						ts.factory.createObjectLiteralExpression([
							ts.factory.createPropertyAssignment('get', this.getRegister(ctx, 2)),
							ts.factory.createPropertyAssignment('set', this.getRegister(ctx, 3)),
						])
					]
				)
			);

		case 'Throw':
			return ts.factory.createThrowStatement(this.getRegister(ctx, 0));
		case 'TypeOf':
			return this.assign(ctx, inst, 
				ts.factory.createTypeOfExpression(this.getRegister(ctx, 1)));
		case 'IsIn':
			return this.assign(ctx, inst,
				ts.factory.createBinaryExpression(
					this.getRegister(ctx, 1),
					ts.SyntaxKind.InKeyword,
					this.getRegister(ctx, 2),
				));
		case 'InstanceOf': {
			const result = this.assign(ctx, inst, 
				ts.factory.createBinaryExpression(
					this.getRegister(ctx, 1),
					ts.SyntaxKind.InstanceOfKeyword,
					this.getRegister(ctx, 2),
				)); //TODO: Figure out "Note that this is not the same as JS instanceof."

			return ts.addSyntheticTrailingComment(result, ts.SyntaxKind.SingleLineCommentTrivia, 'Note that this is not the same as JS instanceof');
		}
		case 'ToNumber':
			return this.assign(ctx, inst, 
				ts.factory.createCallExpression(ts.factory.createIdentifier('Number'), undefined, [this.getRegister(ctx, 1)]));
		case 'AddEmptyString':
			return this.assign(ctx, inst, ts.factory.createAdd(ts.factory.createStringLiteral(''), this.getRegister(ctx, 1)));
		case 'ToInt32':
			return this.assign(ctx, inst, ts.factory.createBitwiseOr(this.getRegister(ctx, 1), ts.factory.createNumericLiteral(0)));

		case 'GetPNameList':
			return this.assign(ctx, inst, ts.factory.createConditionalExpression(
				this.getRegister(ctx, 1),
				undefined,
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						ts.factory.createCallExpression(
							ts.factory.createPropertyAccessExpression(ts.factory.createIdentifier('Object'), 'keys'), 
							undefined,
							[this.getRegister(ctx, 1)]),
						'slice'
					),
					undefined,
					[this.getRegister(ctx, 2)]
				)
				,
				undefined,
				ts.factory.createArrayLiteralExpression()
			)); //TODO:
		case 'GetNextPName':
			return this.assign(ctx, inst, ts.factory.createElementAccessExpression(
				this.getRegister(ctx, 1),
				this.getRegister(ctx, 2)
			)); //TODO:
		case 'GetArgumentsLength':
			return this.assign(ctx, inst, ts.factory.createPropertyAccessExpression(
				ts.factory.createIdentifier('arguments'),
				'length'
			)); //TODO: 
		case 'GetArgumentsPropByVal':
			return this.assign(ctx, inst, ts.factory.createElementAccessExpression(
				ts.factory.createIdentifier('arguments'),
				this.getRegister(ctx, 1)
			)); //TODO: 
		case 'ReifyArguments':
			return this.assign(ctx, inst, ts.factory.createIdentifier('arguments')); //TODO: 
		
		case 'SelectObject':
			return this.assign(ctx, inst, 
				ts.factory.createConditionalExpression(
					ts.factory.createBinaryExpression(
						this.getRegister(ctx, 2),
						ts.SyntaxKind.InstanceOfKeyword,
						ts.factory.createIdentifier('Object')
					),
					undefined,
					this.getRegister(ctx, 2),
					undefined,
					this.getRegister(ctx, 1)
				)
			);

		case 'LoadThisNS':
			return this.assign(ctx, inst, ts.factory.createThis());

		case 'DeclareGlobalVar':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					ts.factory.createPropertyAccessExpression(
						ts.factory.createIdentifier('globalThis'),
						inst.operands[0].value as string
					),
					ts.factory.createVoidZero()
				)
			);
		case 'GetGlobalObject':
			return this.assign(ctx, inst,
				ts.factory.createIdentifier('globalThis'));
		case 'Mov':
		case 'MovLong':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					this.getRegister(ctx, inst.operands[1].value as number),
				)
			);
		case 'Add':
		case 'AddN':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					ts.factory.createAdd(
						this.getRegister(ctx, inst.operands[1].value as number),
						this.getRegister(ctx, inst.operands[2].value as number),
					)
				)
			);
		case 'Sub':
		case 'SubN':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					ts.factory.createSubtract(
						this.getRegister(ctx, inst.operands[1].value as number),
						this.getRegister(ctx, inst.operands[2].value as number),
					)
				)
			);
		case 'Mul':
		case 'MulN':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					ts.factory.createMultiply(
						this.getRegister(ctx, inst.operands[1].value as number),
						this.getRegister(ctx, inst.operands[2].value as number),
					)
				)
			);
		case 'Div':
		case 'DivN':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					ts.factory.createMultiply(
						this.getRegister(ctx, inst.operands[1].value as number),
						this.getRegister(ctx, inst.operands[2].value as number),
					)
				)
			);
		case 'Mod':
			return this.assign(ctx, inst,
				ts.factory.createModulo(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'BitAnd':
			return this.assign(ctx, inst,
				ts.factory.createBitwiseAnd(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'BitOr':
			return this.assign(ctx, inst,
				ts.factory.createBitwiseOr(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'BitXor':
			return this.assign(ctx, inst,
				ts.factory.createBitwiseXor(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'BitNot':
			return this.assign(ctx, inst,
				ts.factory.createBitwiseNot(
					this.getRegister(ctx, inst.operands[1].value as number),
				)
			);
		case 'LShift':
			return this.assign(ctx, inst,
				ts.factory.createLeftShift(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'RShift':
			return this.assign(ctx, inst,
				ts.factory.createRightShift(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'URshift':
			return this.assign(ctx, inst,
				ts.factory.createUnsignedRightShift(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'Negate':
			return this.assign(ctx, inst,
				ts.factory.createPrefixMinus(
					this.getRegister(ctx, inst.operands[1].value as number),
				)
			);

		case 'Not':
			return this.assign(ctx, inst,
				ts.factory.createLogicalNot(
					this.getRegister(ctx, inst.operands[1].value as number),
				)
			);
		case 'Eq':
			return this.assign(ctx, inst,
				ts.factory.createEquality(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'StrictEq':
			return this.assign(ctx, inst,
				ts.factory.createStrictEquality(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'Neq':
			return this.assign(ctx, inst,
				ts.factory.createInequality(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'StrictNeq':
			return this.assign(ctx, inst,
				ts.factory.createStrictInequality(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'Greater':
			return this.assign(ctx, inst,
				ts.factory.createGreaterThan(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'GreaterEq':
			return this.assign(ctx, inst,
				ts.factory.createGreaterThan(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'Less':
			return this.assign(ctx, inst,
				ts.factory.createLessThan(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
		case 'LessEq':
			return this.assign(ctx, inst,
				ts.factory.createLessThanEquals(
					this.getRegister(ctx, inst.operands[1].value as number),
					this.getRegister(ctx, inst.operands[2].value as number),
				)
			);
	


		case 'LoadParam':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					this.getParameter(ctx, inst.operands[1].value as number)
				)
			);

		case 'CreateEnvironment': {
			const origin = ts.factory.createExpressionStatement(ts.factory.createVoidZero());
			const env: Environment = {
				parent: ctx.env,
				vars: [],
				origin,
			};
			ctx.envs.push(env);
			scope.envRegs[inst.operands[0].value as number] = env;
			return origin;
		}
		case 'GetEnvironment': {
			let env = ctx.env;
			for (let i = 0; i < (inst.operands[1].value as number); i++) {
				env = env.parent;
			}
			scope.envRegs[inst.operands[0].value as number] = env;
			return ts.factory.createEmptyStatement();
		}
		case 'StoreToEnvironment':
		case 'StoreToEnvironmentL':
		case 'StoreNPToEnvironment':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getEnvironmentVariable(
						scope,
						inst.operands[0].value as number,
						inst.operands[1].value as number
					),
					this.getRegister(ctx, inst.operands[2].value as number)
				)
			);
		case 'LoadFromEnvironment':
		case 'LoadFromEnvironmentL':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					this.getEnvironmentVariable(
						scope,
						inst.operands[1].value as number,
						inst.operands[2].value as number
					)
				)
			);

		case 'CreateClosure':
			return ts.factory.createExpressionStatement(
				ts.factory.createAssignment(
					this.getRegister(ctx, inst.operands[0].value as number),
					this.decompileFunction({
						params: [],
						regs: [],
						env: this.getEnvironment(scope, inst.operands[1].value as number),
						envs: [],
						queue: [],
						completed: new Map(),
					}, this.header.functionHeaders[inst.operands[2].value as number])
				)
			);
			
		case 'CreateThis':
			return ts.addSyntheticTrailingComment(ts.factory.createEmptyStatement(), ts.SyntaxKind.SingleLineCommentTrivia, 'this instruction is followed by mov instructions that pass the arguments for Construct');
		case 'Construct':
			return this.assign(ctx, inst,
				ts.factory.createNewExpression(this.getRegister(ctx, 1), undefined, []) //TODO: arguments
			);

		//Not implemented 
		case 'Call':
			return ts.addSyntheticTrailingComment(
				ts.factory.createExpressionStatement(
					ts.factory.createVoidZero()
				),
				ts.SyntaxKind.SingleLineCommentTrivia,
				'TODO: Decompiler: ' + inst.opcode
			);
		default:
			Decompiler.warnings.add(inst.opcode);
			return ts.factory.createThrowStatement(
				ts.factory.createNewExpression(
					ts.factory.createIdentifier('Error'),
					undefined,
					[ts.factory.createStringLiteral('Decompiler error: Opcode not implemented: ' + inst.opcode)]
				)
			);
		}

		// return ts.factory.createExpressionStatement(ts.factory.createStringLiteral(inst.opcode));
	}


	private assign(ctx: Context, inst: Instruction, node: ts.Expression) {
		return ts.factory.createExpressionStatement(
			ts.factory.createAssignment(
				this.getRegister(ctx, inst.operands[0].value as number),
				node
			)
		);
	}
	
	private condition(node: ts.Expression) {
		return ts.factory.createExpressionStatement(
			ts.factory.createAssignment(
				ts.factory.createIdentifier('flag'),
				node
			)
		);
	}
	private conditionNot(node: ts.Expression) {
		return ts.factory.createExpressionStatement(
			ts.factory.createAssignment(
				ts.factory.createIdentifier('flag'),
				ts.factory.createLogicalNot(node)
			)
		);
	}

	private getRegister(ctx: Context, register: number) {
		if (ctx.regs[register]) {
			return ctx.regs[register];
		}

		return ctx.regs[register] = ts.factory.createIdentifier('__reg__' + register);
	}

	private getParameter(ctx: Context, nr: number) {
		if (nr === 0) {
			return ts.factory.createThis();
		}

		return ctx.params[nr - 1];
	}

	private getEnvironment(scope: Scope, reg: number) {
		while (scope != scope.parent && !scope.envRegs[reg]) {
			scope = scope.parent;
		}
		return scope.envRegs[reg];
	}

	private getEnvironmentVariable(scope: Scope, reg: number, nr: number) {
		const env = this.getEnvironment(scope, reg);
		if (!env) {
			return ts.factory.createIdentifier('error_decompiler_no_environment');
		} 

		if (env.vars[nr]) {
			return env.vars[nr];
		}

		return env.vars[nr] = ts.factory.createIdentifier('__envreg__' + nr);
	}
	
	private toLiteral(value: unknown): ts.Expression {
		if (value === null) {
			return ts.factory.createNull();
		}
		if (value === true) {
			return ts.factory.createTrue();
		}
		if (value === false) {
			return ts.factory.createTrue();
		}
		if (typeof value === 'string') {
			return ts.factory.createStringLiteral(value);
		}
		if (typeof value === 'number') {
			return ts.factory.createNumericLiteral(value);
		}
		
		throw new Error('Unknown literal type: ' + typeof value);
	}

	// private printCtrlFlow() {
	// 	let text = '';
		
	// 	for (const [i, func] of Object.entries(this.header.functionHeaders)) {
	// 		if (Number(i) % 1000 === 99) {
	// 			console.log(`progress: ${i+1}/${header.functionHeaders.length} (${Number(i) / header.functionHeaders.length * 100}%)`);
	// 		}
		
	// 		text += `function f${header.functionHeaders.indexOf(func)}() { //${func.offset}\n`;
		
	// 		try {
	// 			// ctrlFlow.buildControlFlow(func);
	// 			text += ctrlFlow.buildAndPrint(func);
	// 		} catch (e) {
	// 			text += (e as any)?.stack;
	// 		}
		
	// 		text += '}\n\n';
	// 	}
	// }
	// private printInstrs() {
	// 	let result = '';
	// 	for (const [i, func] of Object.entries(this.header.functionHeaders)) {
	// 		if (Number(i) % 100 === 99) {
	// 			console.log(`progress: ${i}/${this.header.functionHeaders.length} (${Number(i) / this.header.functionHeaders.length * 100}%)`);
	// 		}

	// 		result += `func ${i} //${func.offset}\n`;

	// 		try {
	// 			const instrs = this.disassembler.disassemble(func);
	// 			for (const instr of instrs) {
	// 				result += `  ${instr.ip}: ${instr.opcode}`;
	
	// 				for (const op of instr.operands) {
	// 					result += ' ' + op.type + ':' + op.value;
	// 				}
	
	// 				result += '\n';
	// 			}
	// 		} catch (e) {
	// 			result += e + '\n';
	// 		}
	
	// 		result += '\n';
	// 	}

	// 	return result;
	// }
	// 	private printInstrs(header: FunctionHeader) {
	// 		let result = '';
	// 		try {
	// 			const instrs = this.disassembler.disassemble(header);
	// 			for (const instr of instrs) {
	// 				result += `  ${instr.ip}: ${instr.opcode}`;
	
	// 				for (const op of instr.operands) {
	// 					result += ' ' + op.type + ':' + op.value;
	// 				}
	
	// 				result += '\n';
	// 			}
	// 		} catch (e) {
	// 			result += e + '\n';
	// 		}

	// 		return result;
	// 	}
}