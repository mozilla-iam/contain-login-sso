# SSO Login Container

Inspired from <https://github.com/mozilla/contain-facebook>.

**Automatically redirect certain SSO Logins from Mozilla IAM to a SSO Login container** ("send my work logins to a work
container").

**Note:** To learn more about Containers in general, see [Firefox Multi-Account Containers](https://support.mozilla.org/kb/containers).

**Status:** **POC**

## How does it work?

This extension intercepts login requests from Mozilla IAM that look like an LDAP login, creates a new container if
absent, and transfer your login attempt and related cookies (IAM cookies and RP cookies) to the new container, leaving
no trace in the default container.

Any time you login from your default container, you will be redirected to the correct SSO Login/work container.
