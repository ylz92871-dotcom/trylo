from windows_mcp.runtime.identity import IdentityFactory


def test_identity_factory_is_deterministic_with_fixed_secret_and_sequence() -> None:
    first = IdentityFactory(secret=b"a" * 32)
    second = IdentityFactory(secret=b"a" * 32)

    assert first.new_id("snapshot", 1) == second.new_id("snapshot", 1)
    assert first.new_id("element", (1, 2)) == second.new_id("element", (1, 2))


def test_opaque_id_does_not_expose_identity_material() -> None:
    factory = IdentityFactory(secret=b"b" * 32)
    opaque = factory.new_id("element", r"C:\Users\Alice\secret.txt", "Save")

    assert opaque.startswith("element_")
    assert "Alice" not in opaque
    assert "secret" not in opaque
    assert "Save" not in opaque


def test_executable_hash_normalizes_case_and_path_separator() -> None:
    assert IdentityFactory.executable_path_hash(r"C:\Windows\NOTEPAD.EXE") == (
        IdentityFactory.executable_path_hash("c:/windows/notepad.exe")
    )
