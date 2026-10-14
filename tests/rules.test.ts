import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildTitlePrompt, classify, createRulesSource, normalizeRules, rulesFromMappings } from "../src/rules"

const rules = normalizeRules([
  { folder: "Sales", description: "accounts, prospects, CRM", keywords: ["cotización", "cliente*", "salesforce"] },
  { folder: "Tech", keywords: ["script", "docker"], directories: ["/home/me/code"] },
  { folder: "Personal", tags: ["Personal", "Family"], keywords: ["impuestos", "familia"] },
]).rules

describe("classify", () => {
  test("an explicit tag wins over a keyword that points elsewhere", () => {
    const match = classify("Docker para el cliente [Personal]", undefined, rules)
    expect(match).toMatchObject({ status: "match", folder: "Personal", via: "tag" })
  })

  test("tags default to the folder name and match case-insensitively; extra tags work", () => {
    expect(classify("x [sales]", undefined, rules)).toMatchObject({ folder: "Sales", via: "tag" })
    expect(classify("x [Family]", undefined, rules)).toMatchObject({ folder: "Personal", via: "tag" })
  })

  test("keywords ignore case and accents and respect word boundaries", () => {
    expect(classify("COTIZACION Acme", undefined, rules)).toMatchObject({ folder: "Sales", via: "keyword" })
    expect(classify("Revisar un descript", undefined, rules)).toMatchObject({ status: "none" })
    expect(classify("Fix script", undefined, rules)).toMatchObject({ folder: "Tech", via: "keyword" })
  })

  test("a trailing * is a prefix match", () => {
    expect(classify("Clientes nuevos", undefined, rules)).toMatchObject({ folder: "Sales", via: "keyword" })
  })

  test("directories match the directory itself and anything inside it, not a sibling that shares a prefix", () => {
    expect(classify("Untitled", "/home/me/code/app", rules)).toMatchObject({ folder: "Tech", via: "directory" })
    expect(classify("Untitled", "/home/me/code", rules)).toMatchObject({ folder: "Tech", via: "directory" })
    expect(classify("Untitled", "/home/me/codebase", rules)).toMatchObject({ status: "none" })
  })

  test("keyword beats directory; rule order decides within a level", () => {
    expect(classify("Salesforce notes", "/home/me/code", rules)).toMatchObject({ folder: "Sales", via: "keyword" })
  })

  test("[Unfiled] is terminal and is not overridden by a keyword", () => {
    expect(classify("Docker mess [Unfiled]", undefined, rules)).toEqual({ status: "unfiled", label: "Unfiled" })
  })

  test("an unknown tag falls through to keywords instead of blocking them", () => {
    expect(classify("Docker [Whatever]", undefined, rules)).toMatchObject({ folder: "Tech", via: "keyword" })
  })
})

describe("normalizeRules / rulesFromMappings", () => {
  test("drops malformed entries and reports why", () => {
    const result = normalizeRules([{ folder: "" }, "x", { folder: "Ok", directories: ["relative/dir"], tags: ["bad]tag"] }])
    expect(result.rules).toEqual([{ folder: "Ok", tags: [], keywords: [], directories: [] }])
    expect(result.problems.length).toBe(4)
  })

  test("legacy mappings become rules, grouping tags that share a folder", () => {
    expect(rulesFromMappings({ Sales: "Client work", Biz: "Client work", Tech: "Tech", Bad: 3 })).toEqual([
      { folder: "Client work", tags: ["Sales", "Biz"], keywords: [], directories: [] },
      { folder: "Tech", tags: ["Tech"], keywords: [], directories: [] },
    ])
  })
})

describe("buildTitlePrompt", () => {
  test("offers exactly the tags the rules map, with their descriptions, plus [Unfiled]", () => {
    const prompt = buildTitlePrompt(rules)
    expect(prompt).toContain("- [Sales] — accounts, prospects, CRM.")
    expect(prompt).toContain("- [Tech]")
    expect(prompt).toContain("- [Personal]")
    expect(prompt).not.toContain("[Family]")
    expect(prompt).toContain("[Unfiled]")
  })

  test("a rule with no tags is not offered to the title model", () => {
    const only = normalizeRules([{ folder: "Docs", tags: [], keywords: ["readme"] }]).rules
    expect(buildTitlePrompt(only)).not.toContain("Docs")
  })
})

describe("createRulesSource (rulesFile)", () => {
  const errorSpy = spyOn(console, "error").mockImplementation(() => {})
  afterEach(() => errorSpy.mockClear())

  test("hot-reloads on change and keeps the last good rules when the file breaks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "autofile-rules-"))
    const file = join(dir, "rules.json")
    await writeFile(file, JSON.stringify({ rules: [{ folder: "A", keywords: ["alpha"] }] }))
    const source = createRulesSource({ rulesFile: file, inline: [], log: () => {} })
    expect((await source.get())[0]?.folder).toBe("A")

    // Re-checks are throttled to once per 2s; move the clock instead of sleeping.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + 3_000
      await new Promise((resolve) => setTimeout(resolve, 20))
      await writeFile(file, JSON.stringify([{ folder: "B" }]))
      expect((await source.get())[0]?.folder).toBe("B")

      Date.now = () => realNow() + 6_000
      await writeFile(file, "{ not json")
      expect((await source.get())[0]?.folder).toBe("B")
      expect(source.problems().length).toBe(1)
    } finally {
      Date.now = realNow
    }
  })
})
