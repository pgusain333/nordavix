import uuid
from typing import BinaryIO

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from core.config import settings

# R2 is S3-compatible. The endpoint URL is the only difference from standard S3 usage.
_s3 = boto3.client(
    "s3",
    endpoint_url=settings.r2_endpoint_url,
    aws_access_key_id=settings.r2_access_key_id,
    aws_secret_access_key=settings.r2_secret_access_key,
    config=Config(signature_version="s3v4"),
    region_name="auto",
)


def tenant_key(tenant_id: uuid.UUID, resource_type: str, filename: str) -> str:
    """
    Constructs a tenant-isolated R2 object key.

    Format: {tenant_id}/{resource_type}/{filename}
    This ensures no cross-tenant path collisions and makes per-tenant auditing trivial.
    """
    return f"{tenant_id}/{resource_type}/{filename}"


def upload_file(key: str, file_obj: BinaryIO, content_type: str = "application/octet-stream") -> str:
    """Upload a file-like object to R2. Returns the object key."""
    _s3.upload_fileobj(
        file_obj,
        settings.r2_bucket_name,
        key,
        ExtraArgs={"ContentType": content_type},
    )
    return key


def generate_presigned_download_url(
    key: str,
    expires_in: int = 3600,
    *,
    disposition: str | None = None,
    filename: str | None = None,
    content_type: str | None = None,
) -> str:
    """
    Generate a signed URL for temporary read access to a stored file.

    expires_in: seconds until the URL expires (default 1 hour).
    disposition: when set ("inline" | "attachment"), overrides the response
        Content-Disposition so the browser either renders the file in place
        (inline — the in-app document viewer) or downloads it (attachment).
        `filename` labels the download; `content_type` overrides the served
        MIME (e.g. force text/plain so CSV/TXT render inline instead of
        downloading). Omit all three for the original behaviour.
    URLs are per-object and carry no tenant information in the URL itself —
    access is controlled by the signature, not by the path.
    """
    params: dict[str, str] = {"Bucket": settings.r2_bucket_name, "Key": key}
    if disposition:
        if filename:
            safe = filename.replace('"', "").replace("\n", " ").replace("\r", " ")
            params["ResponseContentDisposition"] = f'{disposition}; filename="{safe}"'
        else:
            params["ResponseContentDisposition"] = disposition
    if content_type:
        params["ResponseContentType"] = content_type
    url: str = _s3.generate_presigned_url(
        "get_object", Params=params, ExpiresIn=expires_in,
    )
    return url


def delete_file(key: str) -> None:
    """Delete an object from R2. Used when a trial balance upload is discarded."""
    try:
        _s3.delete_object(Bucket=settings.r2_bucket_name, Key=key)
    except ClientError:
        # Log but don't raise — a failed delete should not block the user workflow.
        pass


def delete_prefix(prefix: str) -> int:
    """
    Delete every object under a key prefix. Used by the tenant purge job to
    remove a deleted workspace's entire R2 footprint (`{tenant_id}/...`).

    Returns the number of objects deleted. Paginates + batch-deletes (1000 per
    request, the S3 API cap) so it scales to large tenants. Best-effort: a
    failed batch is logged and skipped rather than aborting the whole purge.
    """
    import logging

    logger = logging.getLogger(__name__)
    # Guard against an empty prefix wiping the whole bucket.
    prefix = (prefix or "").strip()
    if not prefix:
        logger.error("delete_prefix called with empty prefix — refusing (would delete entire bucket).")
        return 0

    deleted = 0
    paginator = _s3.get_paginator("list_objects_v2")
    try:
        for page in paginator.paginate(Bucket=settings.r2_bucket_name, Prefix=prefix):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if not objects:
                continue
            # delete_objects caps at 1000 keys per call; paginate already
            # yields <=1000 per page, so one delete per page is safe.
            for i in range(0, len(objects), 1000):
                batch = objects[i : i + 1000]
                try:
                    _s3.delete_objects(
                        Bucket=settings.r2_bucket_name,
                        Delete={"Objects": batch, "Quiet": True},
                    )
                    deleted += len(batch)
                except ClientError as exc:
                    logger.error("delete_prefix batch failed for %s: %s", prefix, exc)
    except ClientError as exc:
        logger.error("delete_prefix listing failed for %s: %s", prefix, exc)
    return deleted
