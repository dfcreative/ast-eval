/**
 * Some helpers
 * @module ast-eval/util
 */

var analyze = require('escope').analyze;
var q = require('esquery');
var types = require('ast-types');
var n = types.namedTypes, b = types.builders;
var evalAst = require('./');
var parse = require('esprima').parse;
var uneval = require('tosource');
var gen = require('escodegen').generate;


/**
 * Test whether node is statically evaluable, in general.
 * Specifically that it is literal or contains only statically known literals.
 *
 * @param {Node} node AST Node to test
 *
 * @return {Boolean} Test result
 */
function isSimple(node){
	if (node === null) return true;

	if (n.CallExpression.check(node)) {
		//simple array method call, like [1,2,3].map(...);
		if (n.MemberExpression.check(node.callee) &&
			(
				n.ArrayExpression.check(getMemberExpressionSource(node.callee)) ||
				isString(getMemberExpressionSource(node.callee))
			) &&
			isSimple(getMemberExpressionSource(node.callee))
		) {
			//method, accepting simple arguments
			if (
				(
					(getCallName(node) in Array.prototype) ||
					(getCallName(node) in String.prototype)
				) &&
				getCallArguments(node).every(function(node){
					//args can be whether evaluable values
					return isSimple(node) ||

					//or any functions
					n.FunctionExpression.check(node);
				})
			) {
				return true;
			}
		}

		//check that both callee is callable and all arguments are ok
		return isSimple(node.callee) && node.arguments.every(isSimple);
	}

	if (n.MemberExpression.check(node)) {
		//`{a:1}.a`, but not `[].x`
		if (isSimple(node.object)){
			//doesn’t call object method
			if (
				n.ObjectExpression.check(node.object) && !(node.property.name in Object.prototype)
			) return true;

			//doesn’t call string method
			if (
				isString(node.object) && !(node.property.name in String.prototype)
			) return true;

			//doesn’t call number method
			if (
				isNumber(node.object) && !(node.property.name in Number.prototype)
			) return true;

			//doesn’t call array method
			if (
				n.ObjectExpression.check(node.object) && !(node.property.name in Array.prototype)
			) return true;

			//doesn’t call function method
			if (
				n.FunctionExpression.check(node.object) && !(node.property.name in Function.prototype)
			) return true;
		}

		//catch Math.*
		if (
			n.Identifier.check(node.object) &&
			node.object.name === 'Math'
		){
			//Math['P' + 'I']
			if (node.computed) {
				if (isSimple(node.property)) {
					var propName = evalAst(node.property);
					return propName in Math;
				}
			}
			//Math.PI
			else {
				return node.property.name in Math;
			}
		}
	}
	//simple expressions go last to let more complex patterns go first
	if (n.ArrayExpression.check(node)) return node.elements.every(isSimple);
	if (n.Literal.check(node)) return true;


	if (n.UnaryExpression.check(node)) return isSimple(node.argument);

	if (n.LogicalExpression.check(node)) {
		return  (isObject(node.left) || isSimple(node.left)) &&
				(isObject(node.right) || isSimple(node.left));
	}

	//calls .valueOf or .toString on objects
	if (n.BinaryExpression.check(node)) return isSimple(node.left) && isSimple(node.right);
	if (n.ConditionalExpression.check(node)) return isSimple(node.test) && isSimple(node.alternate) && isSimple(node.consequent);
	if (n.SequenceExpression.check(node)) return node.expressions.every(isSimple);
	if (n.ObjectExpression.check(node)) return node.properties.every(function(prop){
		return isSimple(prop.value);
	});
	if (n.UpdateExpression.check(node)) return isSimple(node.argument);
	if (n.FunctionExpression.check(node)) return isIsolated(node);
	//known (global) identifiers
	// if (n.Identifier.check(node)) {
	// 	return node.name in global;
	// }

	//FIXME: try to adopt `new Date` etc, to work with concat
	// if (n.NewExpression.check(node)) {
	// 	return isSimple(node.callee) || n.Identifier.check(node.callee) && node.arguments.every(isSimple);
	// }
}



/** Test whether literal is a string */
function isString(node){
	if (n.Literal.check(node) && typeof node.value === 'string') return true;
}
/** Test whether literal is a string */
function isNumber(node){
	if (n.Literal.check(node) && typeof node.value === 'number') return true;
}


/** Test whether node is an object */
function isObject(node){
	if (n.ArrayExpression.check(node)) return true;
	if (n.ObjectExpression.check(node)) return true;
	if (n.FunctionExpression.check(node)) return true;
	if (n.ThisExpression.check(node)) return true;
}


/** Check whether function doesn’t use external variables */
//FIXME: actually check that function has no assignment expressions to external vars, or doesn’t use them in any way.
function isIsolated(node){
	//refuse non-fn nodes
	if (!n.FunctionExpression.check(node)) return;

	//if node refers to external vars - not isolated
	var scope = analyze(node).scopes[0];
	if (scope.through.length) return;

	//also if it includes `ThisExpression` - ignore it, as far `this` isn’t clear
	if (q(node, 'ThisExpression').length) return;

	return true;
}


/** Return name of prop in call expression */
function getCallName(node){
	if (!n.CallExpression.check(node)) return;
	if (!n.MemberExpression.check(node.callee)) return;

	//a.b()
	if (
		!n.MemberExpression.check(node.callee.object) &&
		!node.callee.computed
	)
	return node.callee.property.name;

	//a.b.call()
	if (
		n.MemberExpression.check(node.callee.object) &&
		node.callee.property.name === 'call'
	)
	return node.callee.object.property.name;

	//a.b.apply()
	if (
		n.MemberExpression.check(node.callee.object) &&
		node.callee.property.name === 'apply'
	)

	return node.callee.object.property.name;
}


/** Return arguments of a call */
function getCallArguments(node){
	if (!n.CallExpression.check(node)) return;
	if (!n.MemberExpression.check(node.callee)) return;

	//a.b(1,2,3)
	if (
		!n.MemberExpression.check(node.callee.object) &&
		!node.callee.computed
	)
	return node.arguments;

	//a.b.call(ctx, 1,2,3)
	if (
		n.MemberExpression.check(node.callee.object) &&
		node.callee.property.name === 'call'
	)
	return node.arguments.slice(1);

	//a.b.apply(ctx, [1,2,3])
	if (
		n.MemberExpression.check(node.callee.object) &&
		node.callee.property.name === 'apply' &&
		n.ArrayExpression.check(node.arguments[1])
	)

	return node.arguments[1].elements;
}


/** Get member expression initial node */
function getMemberExpressionSource(node){
	if (!n.MemberExpression.check(node)) return;

	//go deep
	while (n.MemberExpression.check(node)) {
		node = node.object;
	}

	return node;
}


/** Return member expression with decalculated properties, if possible */
function decompute(node){
	types.visit(node, {
		visitMemberExpression: function(path){
			//resolve deep first
			this.traverse(path);
			var node = path.node;

			if (node.computed &&
				isString(node.property)
			) {
				node.computed = false;
				path.get('property').replace(b.identifier(node.property.value));
			}
		}
	});

	return node;
}


/**
 * Get evaluated node (shrunk)
 *
 * @param {Node} node Simple node
 */
function evalNode(node){
	//wrap object expression: `{}` → `({})`
	// if (n.ObjectExpression.check(node))
	node = b.expressionStatement(node);

	//wrap uneval result to expression so to avoid bad uneval, like `{}` → `({})`
	return parse('(' + uneval(eval(gen(node))) + ')').body[0].expression;
}


module.exports = {
	getMemberExpressionSource: getMemberExpressionSource,
	getCallName: getCallName,
	getCallArguments: getCallArguments,
	isString: isString,
	isSimple: isSimple,
	isObject: isObject,
	isIsolated: isIsolated,
	decompute: decompute,
	evalNode: evalNode,
}