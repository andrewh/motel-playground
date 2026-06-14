# Contributing

Thanks for taking a look! To set expectations honestly: this is a personal
experiment, and I'm not actively seeking contributors at the moment. I may be
slow to respond, and I might decline changes that don't fit where I'm taking the
playground — please don't take it personally.

That said, if you've spotted a bug or want to send a fix, you're very welcome to
open an issue or a pull request.

## The one hard rule: tests come with the code

If a change alters behaviour, it must arrive with tests. This isn't negotiable,
but it's not meant to be a hurdle either — it's how I keep a young, fast-moving
project from regressing.

Concretely:

- A bug fix includes a test that fails before the fix and passes after it.
- A new behaviour includes tests that exercise it, including the awkward edge
  cases.
- Tests should check real behaviour, not just that a mock was called.

Pure documentation or comment changes are exempt.

## Running the tests

```sh
go test ./...
```

Please make sure the suite passes before opening a pull request. If something is
genuinely hard to test, say so in the PR and we'll work out a sensible approach
together.

Thanks again for your interest.
