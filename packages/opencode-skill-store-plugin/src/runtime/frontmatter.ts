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
  const metadataAutoinvoke = [nested["opencode/autoinvoke"], opencode.autoinvoke]
    .find((value): value is boolean => typeof value === "boolean")
  const disableModelInvocation = frontmatter["disable-model-invocation"]
  // Match OpenCode's frontmatter contract; the namespaced metadata flag takes precedence.
  const autoinvoke = metadataAutoinvoke ??
    (typeof disableModelInvocation === "boolean" ? !disableModelInvocation : undefined)

  const name = typeof frontmatter.name === "string" && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : fallback.name.trim()
  const description = typeof frontmatter.description === "string" && frontmatter.description.trim()
    ? frontmatter.description.trim()
    : fallback.description.trim()

  return {
    name,
    description,
    autoinvoke: typeof autoinvoke === "boolean" ? autoinvoke : undefined,
    body: markdown.slice(match[0].length).trim(),
  }
}
