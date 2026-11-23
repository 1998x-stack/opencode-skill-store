import { parse } from "yaml"

export type ParsedSkill = {
  name: string
  description: string
  autoinvoke?: boolean
  body: string
}

export function parseSkillMarkdown(markdown: string, fallback: { name: string; description: string }): ParsedSkill {
  const match = markdown.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/)
  if (!match) {
    return { name: fallback.name, description: fallback.description, body: markdown.trim() }
  }

  const metadata = parse(match[1])
  const frontmatter = metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>) : {}
  const nested = frontmatter.metadata !== null && typeof frontmatter.metadata === "object"
    ? (frontmatter.metadata as Record<string, unknown>)
    : {}
  const opencode = nested.opencode !== null && typeof nested.opencode === "object"
    ? (nested.opencode as Record<string, unknown>)
    : {}
  const autoinvoke = nested["opencode/autoinvoke"] ?? opencode.autoinvoke

  return {
    name: typeof frontmatter.name === "string" ? frontmatter.name : fallback.name,
    description: typeof frontmatter.description === "string" ? frontmatter.description : fallback.description,
    autoinvoke: typeof autoinvoke === "boolean" ? autoinvoke : undefined,
    body: markdown.slice(match[0].length).trim(),
  }
}
