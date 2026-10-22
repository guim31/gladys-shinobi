# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

The integration stores nothing under `/data`. The Shinobi API key and group
key are kept by Gladys in the integration configuration; the container holds
them in memory only. Shinobi takes the API key in the path of every request,
so it sends them only to the Shinobi address of the configuration, and never
writes a request address, the key or the group key in a log line or a message.
Over plain HTTP they travel in clear text: put Shinobi behind HTTPS if the
network between Gladys and Shinobi is not trusted. Give the key only the
permissions it needs (see the documentation), and restrict its IP to the
address of Gladys when you can. The integration opens no port.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and Shinobi and the cameras it records.
