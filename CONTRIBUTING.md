# Contributing to ACCESS-CI MCP Servers

We welcome contributions to improve and expand the ACCESS-CI MCP servers!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone <your-fork-url>`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature`

## Development Workflow

### Before Making Changes

- Check existing issues and pull requests
- For major changes, open an issue first to discuss
- Ensure your Node.js version is 18+

### Making Changes

1. Write clean, TypeScript code following existing patterns
2. Add tests for new functionality
3. Update documentation as needed
4. Ensure all tests pass: `npm test`
5. Build successfully: `npm run build`

### Code Style

- We use TypeScript with strict mode
- Follow existing code patterns in the codebase
- No ESLint/Prettier errors: `npm run lint`

### Testing

- Write tests using Vitest
- Place tests in `__tests__` directories
- Run tests: `npm test`
- Run in watch mode: `npm run test:watch`

### Commit Messages

Use clear, descriptive commit messages:

- `feat: Add new tool for resource metrics`
- `fix: Handle empty API responses correctly`
- `docs: Update configuration examples`
- `test: Add tests for error handling`

## Pull Request Process

1. Update documentation for any API changes
2. Ensure all tests pass
3. Update the README if needed
4. Submit PR against the `main` branch
5. Link any related issues

## Adding New MCP Servers

To add a new ACCESS-CI API server:

1. Create new package in `packages/your-server`
2. Extend `BaseAccessServer` from `@access-mcp/shared`
3. Implement required abstract methods, declaring `mutates` on every tool (see "Tool markers" in `CLAUDE.md`)
4. Add to root `tsconfig.json` references
5. Add build script to root `package.json`
6. Create tests, and add the server to `tests/tool-markers.test.ts`
7. Document in package README
8. Update main documentation

## Testing Your Changes

### Unit Tests

```bash
npm test
```

### Integration Testing with MCP Inspector

```bash
npx @modelcontextprotocol/inspector packages/your-server/dist/index.js
```

### Test Release Build

```bash
npm run release
```

## Questions?

- Open an issue for bugs or feature requests
- Check existing documentation in `/docs`
- Reach out to the ACCESS-CI community

Thank you for contributing!
