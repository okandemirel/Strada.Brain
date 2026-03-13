/**
 * Slack Block Kit helpers for building rich message layouts.
 * Provides pre-built blocks for common UI patterns.
 */

import type { KnownBlock, Button, ActionsBlock, SectionBlock, ContextBlock, DividerBlock, HeaderBlock, InputBlock } from "@slack/types";

const MAX_BLOCKS_PER_MESSAGE = 50;


/**
 * Create help blocks showing available commands.
 */
export function createHelpBlocks(botName = "Strada Brain"): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🧠 ${botName} - Unity Development Assistant`,
        emoji: true,
      },
    } as HeaderBlock,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "I'm your AI-powered assistant for Strada.Core Unity projects. Here's what I can do:",
      },
    } as SectionBlock,
    {
      type: "divider",
    } as DividerBlock,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*📁 File Operations*\n• Read, write, and edit C# files\n• Search with glob patterns and grep\n• List directories and analyze code",
      },
    } as SectionBlock,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🏗️ Strada.Core Generation*\n• Create modules, components, mediators\n• Generate systems and service locators\n• Analyze project structure",
      },
    } as SectionBlock,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*🔍 Code Intelligence*\n• Search codebase with RAG\n• Code quality analysis\n• Git operations and diff viewing",
      },
    } as SectionBlock,
    {
      type: "divider",
    } as DividerBlock,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "💡 *Tip:* Mention me with `@" + botName.toLowerCase().replace(/\s/g, "-") + "` or use slash commands",
        },
      ],
    } as ContextBlock,
  ];
}

/**
 * Create confirmation blocks with approve/deny buttons.
 */
export function createConfirmationBlocks(
  question: string,
  details: string | undefined,
  actionIdPrefix: string
): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMarkdown(question)}*`,
      },
    } as SectionBlock,
  ];

  if (details) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `
${escapeMarkdown(details.substring(0, 2900))}${details.length > 2900 ? "..." : ""}
`,
      },
    } as SectionBlock);
  }

  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "✅ Approve",
          emoji: true,
        },
        style: "primary",
        value: "approve",
        action_id: `${actionIdPrefix}_approve`,
      } as Button,
      {
        type: "button",
        text: {
          type: "plain_text",
          text: "❌ Deny",
          emoji: true,
        },
        style: "danger",
        value: "deny",
        action_id: `${actionIdPrefix}_deny`,
      } as Button,
    ],
  } as ActionsBlock);

  return blocks;
}

/**
 * Create a code block section with syntax highlighting.
 */
export function createCodeBlockSection(
  code: string,
  language = "csharp",
  filename?: string
): KnownBlock[] {
  const truncatedCode = code.length > 2900 
    ? code.substring(0, 2900) + "\n\n... (truncated)" 
    : code;

  const blocks: KnownBlock[] = [];

  if (filename) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `📄 *\`${escapeMarkdown(filename)}\`*`,
        },
      ],
    } as ContextBlock);
  }

  blocks.push({
    type: "section",
    text: {
      type: "mrkdwn",
      text: `
\`\`\`${language}
${escapeCodeBlock(truncatedCode)}
\`\`\`
`,
    },
  } as SectionBlock);

  return blocks;
}

/**
 * Create a success notification block.
 */
export function createSuccessBlock(message: string, details?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `✅ *Success*\n${escapeMarkdown(message)}`,
      },
    } as SectionBlock,
  ];

  if (details) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: escapeMarkdown(details.substring(0, 150)),
        },
      ],
    } as ContextBlock);
  }

  return blocks;
}

/**
 * Create an error notification block.
 */
export function createErrorBlock(message: string, error?: string): KnownBlock[] {
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `❌ *Error*\n${escapeMarkdown(message)}`,
      },
    } as SectionBlock,
  ];

  if (error) {
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `
\`\`\`
${escapeCodeBlock(error.substring(0, 2900))}
\`\`\`
`,
      },
    } as SectionBlock);
  }

  return blocks;
}

/**
 * Create an info/warning block.
 */
export function createInfoBlock(message: string, emoji = "ℹ️"): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${emoji} ${escapeMarkdown(message)}`,
      },
    } as SectionBlock,
  ];
}

/**
 * Create a processing/loading block.
 */
export function createProcessingBlock(operation: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `⏳ *Processing*\n${escapeMarkdown(operation)}...`,
      },
    } as SectionBlock,
  ];
}

/**
 * Create a streaming message block that can be updated.
 */
export function createStreamingBlock(text: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: escapeMarkdown(text.substring(0, 2900)) || "⏳ Thinking...",
      },
    } as SectionBlock,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: "🔄 *Streaming...*",
        },
      ],
    } as ContextBlock,
  ];
}

/**
 * Create a modal view for interactive workflows.
 */
export function createModalView(
  title: string,
  blocks: KnownBlock[],
  submitText = "Submit",
  callbackId: string
): {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  blocks: KnownBlock[];
  submit?: { type: "plain_text"; text: string };
  close?: { type: "plain_text"; text: string };
} {
  return {
    type: "modal",
    callback_id: callbackId,
    title: {
      type: "plain_text",
      text: title.substring(0, 24),
    },
    blocks: truncateBlocks(blocks),
    submit: {
      type: "plain_text",
      text: submitText,
    },
    close: {
      type: "plain_text",
      text: "Cancel",
    },
  };
}

/**
 * Create input blocks for a modal.
 */
export function createTextInput(
  blockId: string,
  label: string,
  placeholder?: string,
  multiline = false,
  initialValue?: string,
  required = false
): InputBlock {
  return {
    type: "input",
    block_id: blockId,
    element: {
      type: multiline ? "plain_text_input" : "plain_text_input",
      action_id: `${blockId}_input`,
      placeholder: placeholder
        ? {
            type: "plain_text",
            text: placeholder.substring(0, 100),
          }
        : undefined,
      initial_value: initialValue,
      multiline,
    },
    label: {
      type: "plain_text",
      text: label.substring(0, 80),
    },
    optional: !required,
  };
}

/**
 * Create a file list block.
 */
export function createFileListBlock(files: Array<{ name: string; path: string }>): KnownBlock[] {
  const fileList = files
    .slice(0, 10)
    .map((f) => `• \`${escapeMarkdown(f.name)}\``)
    .join("\n");

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: files.length > 10
          ? `${fileList}\n\n... and ${files.length - 10} more files`
          : fileList,
      },
    } as SectionBlock,
  ];
}

/**
 * Create a collapsible section (using context as workaround).
 */
export function createCollapsibleSection(title: string, content: string): KnownBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeMarkdown(title)}*\n>${escapeMarkdown(content).split("\n").join("\n>")}`,
      },
    } as SectionBlock,
  ];
}

/**
 * Create thread summary blocks.
 */
export function createThreadSummaryBlock(summary: string, messageCount: number): KnownBlock[] {
  return [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: "📝 Thread Summary",
        emoji: true,
      },
    } as HeaderBlock,
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: escapeMarkdown(summary.substring(0, 2900)),
      },
    } as SectionBlock,
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Based on ${messageCount} message${messageCount === 1 ? "" : "s"}`,
        },
      ],
    } as ContextBlock,
  ];
}

/**
 * Escape special characters for Slack mrkdwn.
 */
function escapeMarkdown(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Escape code block content.
 */
function escapeCodeBlock(text: string): string {
  // Don't escape inside code blocks, just handle backticks
  return text.replace(/```/g, "`\`\`");
}

/**
 * Truncate blocks array to fit within Slack limits.
 */
function truncateBlocks(blocks: KnownBlock[]): KnownBlock[] {
  return blocks.slice(0, MAX_BLOCKS_PER_MESSAGE);
}

/**
 * Split long text into multiple blocks.
 */
export function splitLongText(text: string, maxLength = 2900): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Find a good break point
    let breakPoint = remaining.lastIndexOf("\n\n", maxLength);
    if (breakPoint === -1) {
      breakPoint = remaining.lastIndexOf("\n", maxLength);
    }
    if (breakPoint === -1 || breakPoint < maxLength * 0.5) {
      breakPoint = maxLength;
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}

/**
 * Create a divider block.
 */
export function createDivider(): DividerBlock {
  return { type: "divider" };
}

/**
 * Create a context block with metadata.
 */
export function createContextBlock(elements: string[]): ContextBlock {
  return {
    type: "context",
    elements: elements.map((text) => ({
      type: "mrkdwn",
      text: escapeMarkdown(text.substring(0, 150)),
    })),
  };
}
