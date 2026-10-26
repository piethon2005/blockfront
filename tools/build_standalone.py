#!/usr/bin/env python3
"""
Bundle the modular BATLZON project into ONE html file that runs by
double-clicking (no local server needed). Three.js still loads from the CDN.

Usage (from the project root):
    python tools/build_standalone.py
Output:
    batlzon-standalone.html

How it works: every local ES module is wrapped in its own function scope,
its `export`s are returned as an object, and its local `import { ... }`
lines become destructuring from that object. Imports of 'three' and
'three/addons/...' are hoisted to the top and resolved by the import map.
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENTRY = os.path.join(ROOT, "src", "main.js")

NAMED_IMPORT = re.compile(r"import\s*\{([^}]*)\}\s*from\s*'([^']+)';", re.S)
NAMESPACE_IMPORT = re.compile(r"import\s*\*\s*as\s+(\w+)\s+from\s*'([^']+)';")
EXPORT_DECL = re.compile(r"^export\s+(async\s+function|function|class|const|let)\s+(\w+)", re.M)

modules = {}          # absolute path -> dict(name, body, exports)
order = []            # dependency order
hoisted = []          # external import statements (three, addons)


def module_var(path):
    rel = os.path.relpath(path, os.path.join(ROOT, "src"))
    return "__module_" + re.sub(r"\W", "_", rel[:-3])


def load(path):
    if path in modules:
        return
    with open(path, encoding="utf-8") as handle:
        source = handle.read()
    modules[path] = None  # mark as in progress
    header_lines = []

    def replace_namespace(match):
        alias, specifier = match.group(1), match.group(2)
        statement = f"import * as {alias} from '{specifier}';"
        if specifier.startswith("."):
            raise SystemExit(f"Namespace import of a local module is not supported: {path}")
        if statement not in hoisted:
            hoisted.append(statement)
        return ""

    def replace_named(match):
        names, specifier = match.group(1), match.group(2)
        if not specifier.startswith("."):
            statement = "import {" + names + "} from '" + specifier + "';"
            if statement not in hoisted:
                hoisted.append(statement)
            return ""
        dependency = os.path.normpath(os.path.join(os.path.dirname(path), specifier))
        load(dependency)
        bindings = []
        for part in names.split(","):
            part = part.strip()
            if not part:
                continue
            if " as " in part:
                original, alias = [piece.strip() for piece in part.split(" as ")]
                bindings.append(f"{original}: {alias}")
            else:
                bindings.append(part)
        header_lines.append("const { " + ", ".join(bindings) + " } = " + module_var(dependency) + ";")
        return ""

    source = NAMESPACE_IMPORT.sub(replace_namespace, source)
    source = NAMED_IMPORT.sub(replace_named, source)
    exports = [match.group(2) for match in EXPORT_DECL.finditer(source)]
    source = re.sub(r"^export\s+", "", source, flags=re.M)
    modules[path] = {"var": module_var(path), "header": header_lines, "body": source, "exports": exports}
    order.append(path)


def main():
    load(ENTRY)
    parts = list(hoisted)
    for path in order:
        module = modules[path]
        rel = os.path.relpath(path, ROOT)
        parts.append(f"// ===== {rel} =====")
        parts.append(f"const {module['var']} = (() => {{")
        parts.extend(module["header"])
        parts.append(module["body"])
        parts.append("return { " + ", ".join(module["exports"]) + " };")
        parts.append("})();")
    bundle = "\n".join(parts)

    with open(os.path.join(ROOT, "index.html"), encoding="utf-8") as handle:
        html = handle.read()
    with open(os.path.join(ROOT, "css", "styles.css"), encoding="utf-8") as handle:
        css = handle.read()

    html = html.replace('<link rel="stylesheet" href="css/styles.css">', "<style>\n" + css + "\n</style>")
    module_tag = '<script type="module" src="src/main.js"></script>'
    if module_tag not in html:
        raise SystemExit("Could not find the main module script tag in index.html")
    html = html.replace(module_tag, '<script type="module">\n' + bundle.replace("</script>", "<\\/script>") + "\n</script>")

    output_path = os.path.join(ROOT, "batlzon-standalone.html")
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(html)
    print(f"Wrote {output_path} ({len(html) // 1024} KB, {len(order)} modules)")


if __name__ == "__main__":
    sys.exit(main())
