"use client";

import { RemoteTrackPublication, RemoteVideoTrack, RoomEvent, Track, type Room } from "livekit-client";
import { useEffect } from "react";

/**
 * Only cameras that are on screen cost bandwidth.
 *
 * LiveKit's adaptive stream pauses a video track once none of its elements is visible, and
 * resumes it within a frame or two when one is. That covers tiles leaving the screen (paging,
 * the filmstrip, a speaker change). What it does not cover is a camera that has *never* been
 * attached to an element: the server keeps sending its lowest layer indefinitely. In a
 * 50-person call that is dozens of streams nobody is looking at.
 *
 * So when a camera is subscribed we attach it once to a throwaway element and detach it again.
 * That makes adaptive stream evaluate it as "not visible" and pause it until a tile shows it.
 *
 * Why not unsubscribe off-screen cameras instead? It was tried and measured: every
 * subscribe/unsubscribe renegotiates the peer connection, the session description grows with
 * each one, and after a few minutes of speaker changes in a large room the renegotiations alone
 * were blocking the main thread for hundreds of milliseconds. Staying subscribed and paused has
 * a fixed cost paid once at join. Audio is never touched: everyone is always heard.
 */
export function useOffscreenVideoPause(room: Room) {
  useEffect(() => {
    const pause = (track: unknown, pub: unknown) => {
      if (!(pub instanceof RemoteTrackPublication) || pub.source !== Track.Source.Camera) return;
      if (!(track instanceof RemoteVideoTrack) || track.attachedElements.length > 0) return;
      // Give a tile that is about to show this track the chance to attach first.
      setTimeout(() => {
        if (track.attachedElements.length > 0) return;
        const probe = document.createElement("video");
        track.attach(probe);
        track.detach(probe);
      }, 250);
    };
    const sweep = () =>
      room.remoteParticipants.forEach((participant) =>
        participant.trackPublications.forEach((pub) => pause(pub.track, pub)),
      );
    sweep();
    room.on(RoomEvent.Connected, sweep);
    room.on(RoomEvent.TrackSubscribed, pause);
    return () => {
      room.off(RoomEvent.Connected, sweep);
      room.off(RoomEvent.TrackSubscribed, pause);
    };
  }, [room]);
}
