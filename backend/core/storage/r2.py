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


def generate_presigned_download_url(key: str, expires_in: int = 3600) -> str:
    """
    Generate a signed URL for temporary read access to a stored file.

    expires_in: seconds until the URL expires (default 1 hour).
    URLs are per-object and carry no tenant information in the URL itself —
    access is controlled by the signature, not by the path.
    """
    url: str = _s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": settings.r2_bucket_name, "Key": key},
        ExpiresIn=expires_in,
    )
    return url


def delete_file(key: str) -> None:
    """Delete an object from R2. Used when a trial balance upload is discarded."""
    try:
        _s3.delete_object(Bucket=settings.r2_bucket_name, Key=key)
    except ClientError:
        # Log but don't raise — a failed delete should not block the user workflow.
        pass
