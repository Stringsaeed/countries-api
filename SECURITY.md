# Security

Report vulnerabilities privately through the repository's GitHub security advisory feature. Enable private vulnerability reporting when publishing this repository. Do not put production credentials, App Attest receipts, or device identifiers in public issues.

Production requires App Attest proof on every data request. The baseline verifier validates Apple's original attestation protocol. Additional optional signed extension policies and Apple's fraud-assessment receipt service need separate integration before making stronger distribution or device-risk claims. No mechanism prevents redistribution of data downloaded by a legitimate app instance.

Keep deployment credentials scoped, back up encrypted infrastructure state privately, and separate staging from production. Never publish R2 directly or add outer-response cache rules that bypass authentication.
