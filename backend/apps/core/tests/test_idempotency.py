import uuid

from apps.core.idempotency import hash_request


def test_hash_request_is_stable_across_key_order() -> None:
    payload_a = {"trip": "1", "seats": [{"seat": "a", "from_stop": "b"}]}
    payload_b = {"seats": [{"from_stop": "b", "seat": "a"}], "trip": "1"}
    assert hash_request(payload_a) == hash_request(payload_b)


def test_hash_request_differs_for_different_payloads() -> None:
    assert hash_request({"trip": "1"}) != hash_request({"trip": "2"})


def test_hash_request_handles_non_json_native_values() -> None:
    # UUID isn't natively JSON-serializable — hash_request's default=str
    # must cover it without raising, since real callers pass UUID pks.
    hash_request({"trip": uuid.uuid4()})
