---
name: security-review
description: Assess code changes or a specified component for exploitable security issues. Use for an explicit security review, audit or secure coding request.
---

# Review security

Identify the requested code, languages, frameworks, entry points and deployment assumptions. Read project security requirements and existing controls before applying general advice. Use the framework's official guidance when a version-specific claim needs verification.

Trace untrusted input to operations that read or change files, execute commands, query data, fetch URLs, render content or change identity and permissions. Check whether authorization is enforced at the point of use, whether credentials or private data can cross an unintended boundary, and whether an attacker can influence those operations. Inspect the existing validation and escaping before proposing another layer.

Use local synthetic examples to confirm a suspected path. Do not scan or exploit a live target, retrieve real secrets or send source to another service without authorization for that action. An unavailable scanner or framework reference is a coverage gap, not evidence of safety.

Each finding needs a file and line, attacker-controlled input, required access or configuration, the reachable effect, and evidence that the existing controls do not prevent it. Explain severity through likely impact and exploit prerequisites. Label uncertain paths as needing evidence; do not present a missing optional header or preferred coding style as a demonstrated vulnerability.

Default to reporting. If the user requested repairs, fix supported issues using existing framework or project controls and add a regression for the exploit and legitimate use. Do not introduce speculative checks, broad exception handling or a new security abstraction without a demonstrated need.

Return prioritized findings and the scope and checks completed. Follow the project's private reporting process for sensitive findings; publish nothing unless asked. A clean result means no supported findings within the inspected scope, not a guarantee that the system is secure.
