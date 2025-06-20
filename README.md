# Markdown Canvas: Rich Editing for CodeMirror 6

Markdown Canvas is a plugin for CodeMirror 6 that provides a rich editing experience for Markdown content. It creates a hybrid rich-text editor where Markdown syntax is visually styled and hidden, but revealed for editing when the cursor is positioned on certain lines or within specific elements. Inspired by Obsidian's Markdown Live Preview.

The plugin takes advantage of the [lezer-markdown](https://github.com/lezer-parser/markdown) tokenizer that comes with CodeMirror's [Markdown language support](https://github.com/codemirror/lang-markdown). For standard Markdown elements like headings, lists, links, fenced code blocks, and inline formatting spans the plugin relies on CodeMirror highlighting rules to apply rich formatting and wraps a `cm-markdoc-hidden` class around the Markdown syntax characters that should be hidden from the user.

For more complex structural elements like tables, blockquotes, and [Markdoc tags](http://markdoc.dev/docs/tags), the plugin replaces the entire content region with a CodeMirror block widget that displays rendered HTML markup. It uses Markdoc to perform the rendering. When the user moves the text cursor into one of the rendered blocks, the widget disappears and the original source text is revealed for editing.

When you add the plugin to a CodeMirror `EditorState`, you can optionally pass in a [Markdoc config object](https://markdoc.dev/docs/config) with custom tag and node definitions. You can refer to the [provided example](example/index.ts) to see basic usage. The plugin also relies on some [specific CSS styling](example/style.css) in order to properly display the rich content. The CSS classes introduced by the plugin are prefixed with `.cm-markdoc-`.

## Installation

```bash
git clone https://github.com/emdashcodes/codemirror-markdown-canvas.git
```

## Development

### Prerequisites

- Node.js 18 or later
- npm

### Setup

```bash
# Install dependencies
npm install

# Start development build (with watch mode)
npm run dev
```

### Available Scripts

#### Code Quality

```bash
# TypeScript type checking
npm run typecheck

# Linting (ESLint)
npm run lint              # Check for linting errors
npm run lint:fix          # Auto-fix linting errors

# Code formatting (Prettier)
npm run format            # Format all code
npm run format:check      # Check if code is properly formatted
```

#### Build

```bash
# Build the plugin
npm run build

# Run complete CI pipeline (typecheck + lint + format + build)
npm run ci
```

#### Running the Example

```bash
cd example
npm install
npm start    # Start development server on http://localhost:8000
```

## Known Issues

- It is still missing proper support for Markdown image syntax
- Clicking inside of rendered blocks causes the cursor to be placed at the equivalent position in the document, which may not match the position of the rendered content
- Nested Markdoc tags do not yet render correctly

## Credits

This project is based on the original [codemirror-rich-markdoc](https://github.com/segphault/codemirror-rich-markdoc) by Ryan Paul. It has been enhanced and developed independently with additional features, bug fixes, additional development tooling, and ongoing maintenance.

Additional special thanks to:

- **[HyperMD](https://github.com/laobubu/HyperMD)** for inspiration and enabling rich Markdown editing in CodeMirror 5
- **[Obsidian](https://obsidian.md)** for UI inspiration and an excellent Markdown editing experience
