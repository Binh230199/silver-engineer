description: Write unit tests following the project's gold standard (Arrange-Act-Assert, one assertion per test, meaningful names)

## Skill: unit-test

### Purpose
Generate production-quality unit tests for a given function, class, or module.

### Trigger
Use this skill when the user asks to:
- Write tests for a function or class
- Add test coverage to a module
- Create a test file for existing code

### Behaviour
1. **Read the target source** to understand its public API, side effects, and dependencies.
2. **Identify test cases** covering:
   - Happy path (normal inputs)
   - Edge cases (empty, null, boundary values)
   - Error paths (expected throws)
   - State mutations (if the function modifies shared state)
3. **Generate test file** using the project's existing test framework (auto-detect from `package.json`).
4. **Follow Arrange-Act-Assert** structure strictly.
5. Each `it()`/`test()` block covers exactly **one behaviour** — no compound assertions.
6. Test names follow the pattern: `"should <expected behaviour> when <condition>"`.

### Output format
```ts
describe('<ClassName or functionName>', () => {
  it('should <expected behaviour> when <condition>', () => {
    // Arrange
    const input = ...;
    // Act
    const result = ...;
    // Assert
    expect(result).toBe(...);
  });
});
```

### Notes
- Mock external dependencies (network, filesystem, DB) using the project's mock library.
- Do NOT test implementation details — test observable behaviour only.
- Prefer `expect(...).toMatchSnapshot()` only for complex object shapes.
