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
