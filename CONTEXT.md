# LittleSpaces

LittleSpaces is a private workspace where an owner creates and uses personal apps through conversation.

## Language

**Owner**:
The person who controls a workspace, approves app changes and supplies integration credentials.

**Applet**:
A personal app with a user interface, records and optional backend actions, created and maintained through conversation.
_Avoid_: Treating a conversation as an applet

**Revision**:
A specific version of an applet's code and action contracts that can be tested and published together.

**Secret**:
A named private value supplied by the owner for integrations. In the proposed simplified model, secrets belong to the workspace and are available for use by every published applet backend.
_Avoid_: Per-app credential grant
