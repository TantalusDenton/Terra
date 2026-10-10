# Only run through the guarded PowerShell recovery workflow. This removes the
# already-confirmed volume-free placeholder via Kurtosis's own service API.
def run(plan, args):
    if args.get("confirmed_placeholder_uuid", "") != "4ee1b38cd00e4a1ab55e57fdfecbd22a":
        fail("Expected the explicitly confirmed temporary validator placeholder")
    plan.remove_service(name="validator-key-generation-cl-validator-keystore")
