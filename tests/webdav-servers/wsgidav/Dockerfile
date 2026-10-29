FROM python:3.13-alpine@sha256:7984cf56ceaddebe4fefeb75d64000b9f45d8b77b11a09b24524da6cdc3af0c8
COPY requirements.txt /requirements.txt
RUN pip install --no-cache-dir -r /requirements.txt
CMD ["wsgidav", "--host=0.0.0.0", "--port=8080", "--root=/data", "--auth=anonymous", "--no-config"]
