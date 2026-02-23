import { describe, it, expect } from "bun:test";
import { createScanner, SgNode } from "../../src/js/ts/index.js";

describe("tree traversal (SgNode)", () => {
  const source = `const x = eval(input);
function foo() { return 42; }
const y = "hello";`;

  it("scanner.root() returns program node", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      expect(root.kind()).toBe("program");
      expect(root.text()).toBe(source);
      expect(root.isNamed()).toBe(true);
      expect(root.childCount()).toBeGreaterThan(0);
      expect(root.namedChildCount()).toBeGreaterThan(0);
    } finally {
      scanner.free();
    }
  });

  it("root.range() returns full span", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const range = scanner.root().range();
      expect(range.startByte).toBe(0);
      expect(range.startRow).toBe(0);
      expect(range.startCol).toBe(0);
      expect(range.endByte).toBeGreaterThan(0);
    } finally {
      scanner.free();
    }
  });

  it("children() returns all children", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      const children = root.children();
      expect(children.length).toBeGreaterThan(0);
      // Root of JS program should have statement children
      expect(children.every(c => c instanceof SgNode)).toBe(true);
    } finally {
      scanner.free();
    }
  });

  it("namedChildren() returns named children only", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const named = scanner.root().namedChildren();
      // All returned nodes should be named
      expect(named.every(c => c.isNamed())).toBe(true);
      // Should have 3 statements: lexical_declaration, function_declaration, lexical_declaration
      expect(named.length).toBe(3);
    } finally {
      scanner.free();
    }
  });

  it("child(i) returns child by index", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      const first = root.child(0);
      expect(first).not.toBeNull();
      expect(first!.kind()).toBe("lexical_declaration");
    } finally {
      scanner.free();
    }
  });

  it("child(i) returns null for out of bounds", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      const bad = root.child(999);
      expect(bad).toBeNull();
    } finally {
      scanner.free();
    }
  });

  it("parent() navigates up", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      const firstChild = root.namedChildren()[0];
      const parent = firstChild.parent();
      expect(parent).not.toBeNull();
      expect(parent!.kind()).toBe("program");
    } finally {
      scanner.free();
    }
  });

  it("parent() of root returns null", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const parent = scanner.root().parent();
      expect(parent).toBeNull();
    } finally {
      scanner.free();
    }
  });

  it("next() and prev() navigate siblings", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const children = scanner.root().namedChildren();
      const first = children[0];
      const second = first.next();
      expect(second).not.toBeNull();
      expect(second!.kind()).toBe("function_declaration");

      const back = second!.prev();
      expect(back).not.toBeNull();
      expect(back!.kind()).toBe("lexical_declaration");
      expect(back!.range().startByte).toBe(first.range().startByte);
    } finally {
      scanner.free();
    }
  });

  it("find() locates first pattern match in subtree", () => {
    const scanner = createScanner(source, "javascript");
    try {
      const root = scanner.root();
      const found = root.find("eval($X)");
      expect(found).not.toBeNull();
      expect(found!.text()).toContain("eval");
    } finally {
      scanner.free();
    }
  });

  it("findAll() locates all matches", () => {
    const scanner = createScanner("eval(a); eval(b); console.log(c);", "javascript");
    try {
      const root = scanner.root();
      const evals = root.findAll("eval($X)");
      // Pattern matches at call_expression level — at least 2 distinct eval calls
      expect(evals.length).toBeGreaterThanOrEqual(2);
      expect(evals.some(n => n.text().includes("eval(a)"))).toBe(true);
      expect(evals.some(n => n.text().includes("eval(b)"))).toBe(true);
    } finally {
      scanner.free();
    }
  });

  it("find() scoped to subtree", () => {
    const scanner = createScanner(
      "function foo() { eval(a); } function bar() { eval(b); }",
      "javascript",
    );
    try {
      const root = scanner.root();
      const fns = root.namedChildren();
      // First function should find eval(a) only
      const first = fns[0].find("eval($X)");
      expect(first).not.toBeNull();
      expect(first!.text()).toContain("eval(a)");
    } finally {
      scanner.free();
    }
  });

  it("findAll() returns empty for no matches", () => {
    const scanner = createScanner("const x = 1;", "javascript");
    try {
      const found = scanner.root().findAll("eval($X)");
      expect(found).toHaveLength(0);
    } finally {
      scanner.free();
    }
  });

  it("matches() checks if node itself matches pattern", () => {
    const scanner = createScanner("eval(input);", "javascript");
    try {
      const root = scanner.root();
      const evalNode = root.find("eval($X)");
      expect(evalNode).not.toBeNull();
      expect(evalNode!.matches("eval($X)")).toBe(true);
      expect(evalNode!.matches("console.log($X)")).toBe(false);
    } finally {
      scanner.free();
    }
  });

  it("text() returns correct source for deep nodes", () => {
    const scanner = createScanner("const x = 42;", "javascript");
    try {
      const root = scanner.root();
      // Navigate to the number literal
      const decl = root.namedChildren()[0]; // lexical_declaration
      const declarator = decl.namedChildren()[0]; // variable_declarator
      const value = declarator.namedChildren()[1]; // number
      expect(value.kind()).toBe("number");
      expect(value.text()).toBe("42");
    } finally {
      scanner.free();
    }
  });

  it("field() gets child by field name", () => {
    const scanner = createScanner("function foo(a, b) { return a + b; }", "javascript");
    try {
      const fn = scanner.root().namedChildren()[0]; // function_declaration
      const name = fn.field("name");
      expect(name).not.toBeNull();
      expect(name!.text()).toBe("foo");

      const params = fn.field("parameters");
      expect(params).not.toBeNull();
      expect(params!.kind()).toBe("formal_parameters");
    } finally {
      scanner.free();
    }
  });

  it("field() returns null for missing field", () => {
    const scanner = createScanner("const x = 1;", "javascript");
    try {
      const root = scanner.root();
      const result = root.field("nonexistent");
      expect(result).toBeNull();
    } finally {
      scanner.free();
    }
  });

  it("works with TypeScript source", () => {
    const scanner = createScanner("const x: number = 42;", "typescript");
    try {
      const root = scanner.root();
      expect(root.kind()).toBe("program");
      expect(root.namedChildCount()).toBeGreaterThan(0);
    } finally {
      scanner.free();
    }
  });

  it("chained traversal: root → child → find → parent", () => {
    const scanner = createScanner(
      "function foo() { eval(x); }",
      "javascript",
    );
    try {
      const root = scanner.root();
      const fn = root.namedChildren()[0];
      expect(fn.kind()).toBe("function_declaration");

      const evalNode = fn.find("eval($X)");
      expect(evalNode).not.toBeNull();

      // Walk up from eval to find the enclosing function
      let node: SgNode | null = evalNode;
      while (node && node.kind() !== "function_declaration") {
        node = node.parent();
      }
      expect(node).not.toBeNull();
      expect(node!.kind()).toBe("function_declaration");
    } finally {
      scanner.free();
    }
  });
});
