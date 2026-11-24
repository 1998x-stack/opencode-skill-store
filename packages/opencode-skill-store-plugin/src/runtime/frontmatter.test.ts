import { describe, expect, test } from "bun:test"
import { parseSkillMarkdown } from "./frontmatter.js"

describe("parseSkillMarkdown", () => {
  test("reads OpenCode frontmatter and preserves the Markdown body", () => {
    const result = parseSkillMarkdown(
      ["---", "name: Research", "description: Evidence-driven research", "metadata:", "  opencode/autoinvoke: false", "---", "", "# Workflow", "Read sources before writing."].join("\n"),
      { name: "Fallback", description: "Fallback description" },
    )
    expect(result).toEqual({
      name: "Research",
      description: "Evidence-driven research",
      autoinvoke: false,
      body: "# Workflow\nRead sources before writing.",
    })
  })
  test("maps disable-model-invocation to the inverse Runtime autoinvoke flag", () => {
    const result = parseSkillMarkdown(
      ["---", "name: Internal Workflow", "description: Only invoke when explicitly requested", "disable-model-invocation: true", "---", "# Internal workflow"].join("\n"),
      { name: "Fallback", description: "Fallback description" },
    )
    expect(result.autoinvoke).toBe(false)
  })
  test("namespaced OpenCode autoinvoke metadata takes precedence over disable-model-invocation", () => {
    const result = parseSkillMarkdown(
      ["---", "name: Explicit Workflow", "description: Explicit precedence", "disable-model-invocation: true", "metadata:", "  opencode/autoinvoke: true", "---", "# Explicit workflow"].join("\n"),
      { name: "Fallback", description: "Fallback description" },
    )
    expect(result.autoinvoke).toBe(true)
  })
  test("uses Store metadata when the package has no frontmatter", () => {
    expect(parseSkillMarkdown("# Research", { name: "Research", description: "A useful Skill" })).toEqual({
      name: "Research", description: "A useful Skill", body: "# Research",
    })
  })
  test("falls back when frontmatter name and description are blank", () => {
    expect(parseSkillMarkdown(
      ["---", 'name: "  "', 'description: ""', "---", "# Instructions"].join("\n"),
      { name: "Store name", description: "Store description" },
    )).toEqual({
      name: "Store name",
      description: "Store description",
      autoinvoke: undefined,
      body: "# Instructions",
    })
  })
  test("does not treat an arbitrary code fence as YAML frontmatter", () => {
    expect(parseSkillMarkdown("## Body\n---\nname: Fake\n---", { name: "Real", description: "Description" }).name).toBe("Real")
  })
})
