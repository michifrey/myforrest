# BRouter (https://github.com/abrensch/brouter) as routing service for the
# path magnet of MyForrest's tours. The routing data (segments, 5°×5° tiles)
# is downloaded on first start into /segments (a volume), see entrypoint.sh.
#
#   docker build -t myforrest-brouter deploy/brouter
#   docker run -p 17777:17777 -v brouter-segments:/segments myforrest-brouter
FROM eclipse-temurin:17-jre

ARG BROUTER_VERSION=1.7.7
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/brouter
# Release archive: the self-contained jar and the standard profiles (profiles2/).
RUN curl -fsSL -o brouter.zip "https://github.com/abrensch/brouter/releases/download/v${BROUTER_VERSION}/brouter-${BROUTER_VERSION}.zip" \
  && unzip -q brouter.zip -d release && rm brouter.zip \
  && jar=$(find release -name 'brouter-*-all.jar' | head -n 1) && test -n "$jar" && mv "$jar" brouter.jar \
  && profiles=$(find release -type d -name profiles2 | head -n 1) && test -n "$profiles" && mv "$profiles" profiles2 \
  && rm -rf release \
  && test -f profiles2/hiking-mountain.brf

COPY entrypoint.sh /usr/local/bin/brouter-entrypoint
RUN chmod 755 /usr/local/bin/brouter-entrypoint \
  && useradd --uid 1000 --create-home brouter 2>/dev/null || true \
  && mkdir -p /segments /customprofiles && chown 1000:1000 /segments /customprofiles

# Area to route in (west,south,east,north); default: Switzerland and Liechtenstein.
ENV BBOX="5.9,45.8,10.5,47.9" \
    SEGMENTS_URL="https://brouter.de/brouter/segments4" \
    REFRESH_DAYS=30 \
    PORT=17777 \
    MAX_THREADS=4 \
    JAVA_OPTS="-Xms128M -Xmx512M -Xmn16M -DmaxRunningTime=60"

USER 1000
VOLUME ["/segments"]
EXPOSE 17777
ENTRYPOINT ["/usr/local/bin/brouter-entrypoint"]
