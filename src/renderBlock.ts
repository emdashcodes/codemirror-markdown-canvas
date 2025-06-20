import { syntaxTree } from '@codemirror/language';
import { RangeSet, StateField } from '@codemirror/state';
import {
  Decoration,
  EditorView,
  WidgetType,
  ViewPlugin,
} from '@codemirror/view';

import markdoc from '@markdoc/markdoc';

import type { EditorState, Range } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import type { Config } from '@markdoc/markdoc';

import { hashString } from './utils';

const RENDERABLE_NODE_TYPES = ['Table', 'Blockquote', 'MarkdocTag'] as const;
function isRenderableNodeType(
  nodeName: string
): nodeName is (typeof RENDERABLE_NODE_TYPES)[number] {
  return (RENDERABLE_NODE_TYPES as readonly string[]).includes(nodeName);
}

// Cache for rendered widget HTML to avoid re-parsing identical content
const widgetCache = new Map<string, string>();

const defaultConfig: Config = {
  nodes: {
    blockquote: {
      render: 'blockquote',
      transform(node, config) {
        const children = node.transformChildren(config);
        return new markdoc.Tag('blockquote', {}, children);
      },
    },
    paragraph: {
      render: 'p',
      transform(node, config) {
        const children = node.transformChildren(config);
        return new markdoc.Tag('p', {}, children);
      },
    },
    softbreak: {
      render: 'br',
      transform() {
        return new markdoc.Tag('br', {});
      },
    },
    hardbreak: {
      render: 'br',
      transform() {
        return new markdoc.Tag('br', {});
      },
    },
  },
};

const patternTag =
  /{%\s*(?<closing>\/)?(?<tag>[a-zA-Z0-9-_]+)(?<attrs>\s+[^]+)?\s*(?<self>\/)?%}\s*$/m;

class RenderBlockWidget extends WidgetType {
  rendered: string;

  constructor(
    public source: string,
    config: Config
  ) {
    super();

    const cacheKey = hashString(source);
    const cachedResult = widgetCache.get(cacheKey);
    if (cachedResult) {
      this.rendered = cachedResult;
      return;
    }

    const mergedConfig = {
      ...defaultConfig,
      nodes: { ...defaultConfig.nodes, ...config.nodes },
      tags: { ...defaultConfig.tags, ...config.tags },
    };

    const document = markdoc.parse(source);
    const transformed = markdoc.transform(document, mergedConfig);
    this.rendered = markdoc.renderers.html(transformed);

    widgetCache.set(cacheKey, this.rendered);
  }

  eq(widget: RenderBlockWidget): boolean {
    return this.source === widget.source;
  }

  toDOM(): HTMLElement {
    const content = document.createElement('div');
    content.setAttribute('contenteditable', 'false');
    content.className = 'cm-markdoc-renderBlock';
    content.innerHTML = this.rendered;
    return content;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

interface TableCell {
  content: string;
  isHeader: boolean;
  alignment?: 'left' | 'center' | 'right';
}

interface TableRow {
  cells: TableCell[];
}

interface ParsedTable {
  rows: TableRow[];
  alignments: ('left' | 'center' | 'right')[];
}

class EditableTableWidget extends WidgetType {
  table: ParsedTable;
  view?: EditorView;
  from: number;
  to: number;
  source: string;
  private isUserTyping: boolean = false;

  constructor(source: string, from: number, to: number, view?: EditorView) {
    super();
    this.source = source;
    this.table = this.parseTable(source);
    this.view = view;
    this.from = from;
    this.to = to;
  }

  parseTable(source: string): ParsedTable {
    const lines = source.trim().split('\n');
    const rows: TableRow[] = [];
    let alignments: ('left' | 'center' | 'right')[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line.startsWith('|')) {
        continue;
      }

      const cellTexts = line
        .split('|')
        .slice(1, -1)
        .map(cell => cell.trim());

      // Check if this is an alignment row
      if (i === 1 && cellTexts.every(cell => /^:?-+:?$/.test(cell))) {
        alignments = cellTexts.map(cell => {
          if (cell.startsWith(':') && cell.endsWith(':')) {
            return 'center';
          }
          if (cell.endsWith(':')) {
            return 'right';
          }
          return 'left';
        });
        continue;
      }

      const cells: TableCell[] = cellTexts.map((content, index) => ({
        content,
        isHeader: i === 0,
        alignment: alignments[index] || 'left',
      }));

      rows.push({ cells });
    }

    return { rows, alignments };
  }

  eq(widget: EditableTableWidget): boolean {
    // Compare the source content to detect changes
    // Only re-render if the table structure or content has meaningfully changed
    return this.source.trim() === widget.source.trim();
  }

  toDOM(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'cm-markdoc-editableTable';
    container.contentEditable = 'false';

    // Prevent the container from triggering mode changes
    container.addEventListener('mousedown', e => {
      // Prevent CodeMirror from handling any mouse events within the table
      e.stopPropagation();
      e.preventDefault();
    });

    // Also prevent other events that might interfere with CodeMirror
    container.addEventListener('click', e => {
      e.stopPropagation();
    });

    container.addEventListener('focusin', e => {
      e.stopPropagation();
    });

    const table = document.createElement('table');
    table.className = 'cm-markdoc-table';

    // Create table content
    this.table.rows.forEach((row, rowIndex) => {
      const tr = document.createElement('tr');

      row.cells.forEach((cell, cellIndex) => {
        const cellElement = document.createElement(cell.isHeader ? 'th' : 'td');
        cellElement.textContent = cell.content;
        cellElement.style.textAlign = cell.alignment || 'left';
        cellElement.contentEditable = 'true';
        cellElement.className = 'cm-markdoc-tableCell';

        // Add event listeners for cell editing
        cellElement.addEventListener('mousedown', e => {
          e.stopPropagation();
          e.preventDefault();
        });

        cellElement.addEventListener('click', e => {
          e.stopPropagation();
          e.preventDefault();
          cellElement.focus();
        });

        // Handle keyboard navigation and editing
        cellElement.addEventListener('keydown', e => {
          e.stopPropagation();

          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this.navigateToNextRow(rowIndex, cellIndex);
          } else if (e.key === 'Tab') {
            e.preventDefault();
            if (e.shiftKey) {
              this.navigateToPrevCell(rowIndex, cellIndex);
            } else {
              this.navigateToNextCell(rowIndex, cellIndex);
            }
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.navigateToPrevRow(rowIndex, cellIndex);
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.navigateToNextRow(rowIndex, cellIndex);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            this.exitTableEditing();
          }
        });

        // Update content when cell changes
        cellElement.addEventListener('input', () => {
          this.updateCell(rowIndex, cellIndex, cellElement.textContent || '');
        });

        // Add simpler hover for last column cells
        if (cellIndex === row.cells.length - 1) {
          cellElement.classList.add('cm-markdoc-lastColumn');
        }

        tr.appendChild(cellElement);
      });

      // Mark last row for simpler hover handling
      if (rowIndex === this.table.rows.length - 1) {
        tr.classList.add('cm-markdoc-lastRow');
      }

      table.appendChild(tr);
    });

    // Add hover controls
    this.addHoverControls(container);

    container.appendChild(table);
    return container;
  }

  addHoverControls(container: HTMLElement) {
    // Add column controls
    const colControls = document.createElement('div');
    colControls.className = 'cm-markdoc-table-colControls';

    // Add row controls
    const rowControls = document.createElement('div');
    rowControls.className = 'cm-markdoc-table-rowControls';

    // Add bottom control for new row
    const addRowBtn = document.createElement('button');
    addRowBtn.className = 'cm-markdoc-table-addRow';
    addRowBtn.textContent = '+';
    addRowBtn.onmousedown = e => {
      e.preventDefault();
      e.stopPropagation();
    };
    addRowBtn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Add row button clicked');
      this.addRow();
    };

    // Add right control for new column
    const addColBtn = document.createElement('button');
    addColBtn.className = 'cm-markdoc-table-addCol';
    addColBtn.textContent = '+';
    addColBtn.onmousedown = e => {
      e.preventDefault();
      e.stopPropagation();
    };
    addColBtn.onclick = e => {
      e.preventDefault();
      e.stopPropagation();
      console.log('Add column button clicked');
      this.addColumn();
    };

    container.appendChild(colControls);
    container.appendChild(rowControls);
    container.appendChild(addRowBtn);
    container.appendChild(addColBtn);

    // Buttons are now controlled by edge-specific hover events
  }

  updateCell(rowIndex: number, cellIndex: number, content: string) {
    if (
      this.table.rows[rowIndex] &&
      this.table.rows[rowIndex].cells[cellIndex]
    ) {
      const currentContent = this.table.rows[rowIndex].cells[cellIndex].content;
      // Only sync if content actually changed
      if (currentContent !== content) {
        this.table.rows[rowIndex].cells[cellIndex].content = content;
        this.syncToDocument();
      }
    }
  }

  addRow() {
    // Ensure we have at least one column
    const numColumns =
      this.table.alignments.length ||
      (this.table.rows.length > 0 ? this.table.rows[0].cells.length : 3);

    const newRow: TableRow = {
      cells: Array.from({ length: numColumns }, (_, index) => ({
        content: '',
        isHeader: false,
        alignment: this.table.alignments[index] || 'left',
      })),
    };

    this.table.rows.push(newRow);
    this.syncToDocument();
  }

  addColumn() {
    // Add cell to each existing row
    this.table.rows.forEach(row => {
      row.cells.push({
        content: '',
        isHeader: row.cells[0]?.isHeader || false,
        alignment: 'left',
      });
    });

    // Add alignment for the new column
    this.table.alignments.push('left');

    this.syncToDocument();
  }

  navigateToNextCell(rowIndex: number, cellIndex: number) {
    const nextCellIndex = cellIndex + 1;
    if (nextCellIndex < this.table.rows[rowIndex].cells.length) {
      this.focusCell(rowIndex, nextCellIndex);
    } else if (rowIndex + 1 < this.table.rows.length) {
      this.focusCell(rowIndex + 1, 0);
    }
  }

  navigateToPrevCell(rowIndex: number, cellIndex: number) {
    const prevCellIndex = cellIndex - 1;
    if (prevCellIndex >= 0) {
      this.focusCell(rowIndex, prevCellIndex);
    } else if (rowIndex - 1 >= 0) {
      this.focusCell(
        rowIndex - 1,
        this.table.rows[rowIndex - 1].cells.length - 1
      );
    }
  }

  navigateToNextRow(rowIndex: number, cellIndex: number) {
    if (rowIndex + 1 < this.table.rows.length) {
      this.focusCell(rowIndex + 1, cellIndex);
    } else {
      // Exit table and return to CodeMirror if at last row
      this.exitTableEditing('down');
    }
  }

  navigateToPrevRow(rowIndex: number, cellIndex: number) {
    if (rowIndex > 0) {
      this.focusCell(rowIndex - 1, cellIndex);
    } else {
      // Exit table and return to CodeMirror if at first row
      this.exitTableEditing('up');
    }
  }

  exitTableEditing(direction?: 'up' | 'down') {
    const activeElement = document.activeElement;
    const storedSelection =
      activeElement && (activeElement as any)._cmSelection;

    const view = this.view || currentView;
    if (view) {
      // If we have a specific direction (up/down arrow), position based on direction
      // If no direction (escape key), use stored selection if available
      if (direction) {
        let targetPosition;
        if (direction === 'up') {
          // Position cursor before the table, at the end of the previous line
          const view = this.view || currentView;
          if (view) {
            const doc = view.state.doc;
            const lineBeforeTable = doc.lineAt(this.from);
            // If we're at the start of a line, move to the end of the previous line
            if (
              this.from === lineBeforeTable.from &&
              lineBeforeTable.number > 1
            ) {
              targetPosition = doc.line(lineBeforeTable.number - 1).to;
            } else {
              targetPosition = this.from;
            }
          } else {
            targetPosition = this.from;
          }
        } else {
          // Position cursor after the table, at the start of the next line
          const view = this.view || currentView;
          if (view) {
            const doc = view.state.doc;
            const lineAfterTable = doc.lineAt(this.to);
            // If we're at the end of a line, move to the start of the next line
            if (
              this.to === lineAfterTable.to &&
              lineAfterTable.number < doc.lines
            ) {
              targetPosition = doc.line(lineAfterTable.number + 1).from;
            } else {
              targetPosition = this.to;
            }
          } else {
            targetPosition = this.to;
          }
        }

        view.dispatch({
          selection: { anchor: targetPosition },
          scrollIntoView: true,
        });
      } else if (storedSelection) {
        view.dispatch({ selection: storedSelection });
      } else {
        view.dispatch({
          selection: { anchor: this.to },
          scrollIntoView: true,
        });
      }
      view.focus();
    }
  }

  focusCell(rowIndex: number, cellIndex: number) {
    // Find the cell in the DOM and focus it
    const tableElement = document.querySelector('.cm-markdoc-table');
    if (tableElement) {
      const rows = tableElement.querySelectorAll('tr');
      if (rows[rowIndex]) {
        const cells = rows[rowIndex].querySelectorAll('.cm-markdoc-tableCell');
        if (cells[cellIndex]) {
          (cells[cellIndex] as HTMLElement).focus();
        }
      }
    }
  }

  syncToDocument() {
    // Skip sync if user is actively typing
    if (this.isUserTyping) {
      return;
    }

    const view = this.view || currentView;
    if (!view) {
      return;
    }

    // Capture focused element before update
    const activeElement = document.activeElement;
    const isTableCell = activeElement?.classList.contains(
      'cm-markdoc-tableCell'
    );
    let focusedRowIndex = -1;
    let focusedCellIndex = -1;

    if (isTableCell) {
      // Find the position of the focused cell
      const table = activeElement.closest('.cm-markdoc-table');
      if (table) {
        const rows = table.querySelectorAll('tr');
        for (let i = 0; i < rows.length; i++) {
          const cells = rows[i].querySelectorAll('.cm-markdoc-tableCell');
          for (let j = 0; j < cells.length; j++) {
            if (cells[j] === activeElement) {
              focusedRowIndex = i;
              focusedCellIndex = j;
              break;
            }
          }
          if (focusedRowIndex >= 0) {
            break;
          }
        }
      }
    }

    const markdownTable = this.tableToMarkdown();

    // Use setTimeout to defer the update until after current update is complete
    setTimeout(() => {
      if (view) {
        // Get the current document state to ensure we have up-to-date positions
        const currentText = view.state.doc.sliceString(this.from, this.to);

        // Only update if the content is actually different
        if (currentText !== markdownTable) {
          view.dispatch({
            changes: {
              from: this.from,
              to: this.to,
              insert: markdownTable,
            },
          });

          // Restore focus after update
          if (isTableCell && focusedRowIndex >= 0 && focusedCellIndex >= 0) {
            setTimeout(() => {
              this.restoreFocus(focusedRowIndex, focusedCellIndex);
            }, 50);
          }
        }
      }
    }, 0);
  }

  restoreFocus(rowIndex: number, cellIndex: number) {
    const table = document.querySelector('.cm-markdoc-table');
    if (table) {
      const rows = table.querySelectorAll('tr');
      if (rows[rowIndex]) {
        const cells = rows[rowIndex].querySelectorAll('.cm-markdoc-tableCell');
        if (cells[cellIndex]) {
          const cell = cells[cellIndex] as HTMLElement;
          cell.focus();

          // Restore cursor position to the end
          const range = document.createRange();
          const selection = window.getSelection();
          if (cell.firstChild) {
            range.setStart(cell.firstChild, cell.textContent?.length || 0);
            range.setEnd(cell.firstChild, cell.textContent?.length || 0);
          } else {
            range.setStart(cell, 0);
            range.setEnd(cell, 0);
          }
          selection?.removeAllRanges();
          selection?.addRange(range);
        }
      }
    }
  }

  tableToMarkdown(): string {
    const lines: string[] = [];

    // Header row
    if (this.table.rows.length > 0) {
      const headerCells = this.table.rows[0].cells.map(cell => cell.content);
      lines.push(`| ${headerCells.join(' | ')} |`);

      // Alignment row - ensure we have enough alignments for all columns
      const numColumns = this.table.rows[0].cells.length;
      const alignments = [...this.table.alignments];
      while (alignments.length < numColumns) {
        alignments.push('left');
      }

      const alignmentCells = alignments.slice(0, numColumns).map(align => {
        switch (align) {
          case 'center':
            return ':------:';
          case 'right':
            return '------:';
          default:
            return '------';
        }
      });
      lines.push(`| ${alignmentCells.join(' | ')} |`);

      // Data rows
      for (let i = 1; i < this.table.rows.length; i++) {
        const dataCells = this.table.rows[i].cells.map(cell => cell.content);
        lines.push(`| ${dataCells.join(' | ')} |`);
      }
    }

    const result = lines.join('\n');
    return result;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

function replaceBlocks(
  state: EditorState,
  config: Config,
  view?: EditorView,
  from?: number,
  to?: number
) {
  const decorations: Range<Decoration>[] = [];
  const [cursor] = state.selection.ranges;

  const tags: [number, number][] = [];
  const stack: number[] = [];

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (!isRenderableNodeType(node.name)) {
        return true;
      }

      if (node.name === 'MarkdocTag') {
        const text = state.doc.sliceString(node.from, node.to);
        const match = text.match(patternTag);

        if (match?.groups?.self) {
          tags.push([node.from, node.to]);
          return true;
        }

        if (match?.groups?.closing) {
          const last = stack.pop();
          if (last) {
            tags.push([last, node.to]);
          }
          return true;
        }

        stack.push(node.from);
        return true;
      }

      // For tables, always render regardless of cursor position
      if (node.name === 'Table') {
        // Continue to render table
      } else if (cursor.from >= node.from && cursor.to <= node.to) {
        return false;
      }

      const text = state.doc.sliceString(node.from, node.to);

      // Use EditableTableWidget for tables, RenderBlockWidget for others
      const widget =
        node.name === 'Table'
          ? new EditableTableWidget(text, node.from, node.to, view)
          : new RenderBlockWidget(text, config);

      const decoration = Decoration.replace({
        widget,
        block: true,
      });

      decorations.push(decoration.range(node.from, node.to));
      return true;
    },
  });

  for (const [from, to] of tags) {
    if (cursor.from >= from && cursor.to <= to) {
      continue;
    }
    const text = state.doc.sliceString(from, to);
    const decoration = Decoration.replace({
      widget: new RenderBlockWidget(text, config),
      block: true,
    });

    decorations.push(decoration.range(from, to));
  }

  return decorations;
}

// Store view reference globally for table widgets to access
let currentView: EditorView | undefined;

export default function (config: Config) {
  return [
    ViewPlugin.define(view => {
      currentView = view;
      return {
        update() {
          currentView = view;
        },
      };
    }),
    StateField.define<DecorationSet>({
      create(state) {
        return RangeSet.of(replaceBlocks(state, config, currentView), true);
      },

      update(oldDecorations, transaction) {
        // Optimize selection-only changes by checking if cursor entered/exited blocks
        if (!transaction.docChanged && transaction.selection) {
          const oldCursor = transaction.startState.selection.main;
          const newCursor = transaction.state.selection.main;
          const oldTree = syntaxTree(transaction.startState);

          let cursorCrossedBlockBoundary = false;
          oldTree.iterate({
            enter(node) {
              if (isRenderableNodeType(node.name)) {
                const oldInBlock =
                  oldCursor.from >= node.from && oldCursor.to <= node.to;
                const newInBlock =
                  newCursor.from >= node.from && newCursor.to <= node.to;

                if (oldInBlock !== newInBlock) {
                  cursorCrossedBlockBoundary = true;
                  return false;
                }
              }
              return true;
            },
          });

          // Use fast path if cursor didn't cross block boundaries
          if (!cursorCrossedBlockBoundary) {
            return oldDecorations.map(transaction.changes);
          }
        }

        // Full recomputation needed
        return RangeSet.of(
          replaceBlocks(transaction.state, config, currentView),
          true
        );
      },

      provide(field) {
        return EditorView.decorations.from(field);
      },
    }),
  ];
}
