# Hinweise für Claude

- Nach jedem Feature README, Doku (`docs/*.md`, inkl. Roadmap) und die betroffenen Screenshots in
  `docs/screenshots/` anpassen, im selben PR wie den Code.
- Doku und Oberfläche sind auf Deutsch (Schweizer Schreibweise, „ss“ statt „ß“).
- Tests: `npm test`.
- Die Doku ist auch eine Website (MkDocs, `mkdocs.yml`): neue Seiten in `nav` eintragen, Links auf Dateien
  ausserhalb von `docs/` als GitHub-URL. Prüfen mit `mkdocs build --strict` (`pip install -r requirements-docs.txt`).
