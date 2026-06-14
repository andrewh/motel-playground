# Contributing

This is a personal experiment, so I'm not actively seeking contributors and may
be slow to respond or decline changes that don't fit the direction. That said,
bug reports and fixes are welcome — feel free to open an issue or a pull request.

Any change that alters behaviour must include tests:

- A bug fix needs a test that fails before the fix and passes after it.
- New behaviour needs tests covering it, including edge cases.
- Test real behaviour, not mocks.

Pure documentation changes are exempt.

Run the tests:

```sh
make test
```

Please make sure the suite passes before opening a pull request.

Thanks.
