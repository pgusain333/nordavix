from celery import Celery

from core.config import settings

celery_app = Celery(
    "nordavix",
    broker=settings.redis_url,
    backend=settings.redis_url,
    # Task modules are discovered here; add new module task files as they're built
    include=["modules.flux.tasks"],
)

celery_app.conf.update(
    task_serializer="json",
    result_serializer="json",
    accept_content=["json"],
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    # Ack after completion so a crashed worker doesn't lose the task
    task_acks_late=True,
    # One AI task at a time per worker — narrative generation can take several seconds
    # and we don't want one slow tenant to starve others. Scale by adding workers.
    worker_prefetch_multiplier=1,
    # Retry failed tasks up to 3 times before marking as failed
    task_max_retries=3,
)
