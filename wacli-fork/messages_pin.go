// wadigest fork patch for wacli 0.22: adds `wacli messages pin`.
// Copied into cmd/wacli/ by wacli-fork/build.sh (or the GitHub Actions workflow).
//
//   wacli messages pin --chat GROUP_JID --id MSG_ID [--duration 7d] [--unpin] [--sender JID]
//
// Sends a WhatsApp PinInChatMessage (pin for everyone). WhatsApp accepts pins of
// 24 hours, 7 days or 30 days; other durations are rounded to the nearest of those.
// In groups where only admins can pin, the linked account must be an admin.
// Needs the store lock: stop `sync --follow` first (wadigest does this for you).

package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/openclaw/wacli/internal/out"
	"github.com/openclaw/wacli/internal/wa"
	"github.com/spf13/cobra"
	"go.mau.fi/whatsmeow/proto/waCommon"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"google.golang.org/protobuf/proto"
)

func pinDurationSeconds(d time.Duration) uint32 {
	options := []time.Duration{24 * time.Hour, 7 * 24 * time.Hour, 30 * 24 * time.Hour}
	best := options[1]
	bestDiff := time.Duration(1<<62 - 1)
	for _, o := range options {
		diff := o - d
		if diff < 0 {
			diff = -diff
		}
		if diff < bestDiff {
			best, bestDiff = o, diff
		}
	}
	return uint32(best / time.Second)
}

func parsePinDuration(s string) (time.Duration, error) {
	s = strings.TrimSpace(strings.ToLower(s))
	if strings.HasSuffix(s, "d") {
		var n int
		if _, err := fmt.Sscanf(strings.TrimSuffix(s, "d"), "%d", &n); err != nil || n <= 0 {
			return 0, fmt.Errorf("invalid --duration %q (use 24h, 7d or 30d)", s)
		}
		return time.Duration(n) * 24 * time.Hour, nil
	}
	d, err := time.ParseDuration(s)
	if err != nil || d <= 0 {
		return 0, fmt.Errorf("invalid --duration %q (use 24h, 7d or 30d)", s)
	}
	return d, nil
}

func newMessagesPinCmd(flags *rootFlags) *cobra.Command {
	var chat, msgID, sender, durationStr string
	var unpin bool

	cmd := &cobra.Command{
		Use:   "pin",
		Short: "Pin (or unpin) a message for everyone in a chat",
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(chat) == "" || strings.TrimSpace(msgID) == "" {
				return fmt.Errorf("--chat and --id are required")
			}
			if err := flags.requireWritable(); err != nil {
				return err
			}
			dur, err := parsePinDuration(durationStr)
			if err != nil {
				return err
			}
			secs := pinDurationSeconds(dur)

			ctx, cancel := withTimeout(context.Background(), flags)
			defer cancel()

			a, lk, err := newApp(ctx, flags, true, false)
			if err != nil {
				return err
			}
			defer closeApp(a, lk)
			if err := a.EnsureAuthed(ctx); err != nil {
				return err
			}
			if err := a.Connect(ctx, false, nil); err != nil {
				return err
			}

			chatJID, err := wa.ParseUserOrJID(chat)
			if err != nil {
				return fmt.Errorf("invalid --chat: %w", err)
			}
			key := &waCommon.MessageKey{
				RemoteJID: proto.String(chatJID.String()),
				ID:        proto.String(msgID),
				FromMe:    proto.Bool(strings.TrimSpace(sender) == ""),
			}
			if strings.TrimSpace(sender) != "" {
				senderJID, err := wa.ParseUserOrJID(sender)
				if err != nil {
					return fmt.Errorf("invalid --sender: %w", err)
				}
				if chatJID.Server == types.GroupServer {
					key.Participant = proto.String(senderJID.ToNonAD().String())
				}
			}
			pinType := waE2E.PinInChatMessage_PIN_FOR_ALL
			if unpin {
				pinType = waE2E.PinInChatMessage_UNPIN_FOR_ALL
			}
			msg := &waE2E.Message{
				PinInChatMessage: &waE2E.PinInChatMessage{
					Key:               key,
					Type:              pinType.Enum(),
					SenderTimestampMS: proto.Int64(time.Now().UnixMilli()),
				},
			}
			if !unpin {
				msg.MessageContextInfo = &waE2E.MessageContextInfo{MessageAddOnDurationInSecs: proto.Uint32(secs)}
			}

			sentID, err := runSendOperation(ctx, reconnectForSend(a), func(ctx context.Context) (types.MessageID, error) {
				return a.WA().SendProtoMessage(ctx, chatJID, msg)
			})
			if err != nil {
				return err
			}
			waitForPostSendRetryReceipts(ctx, postSendRetryReceiptWait)

			if flags.asJSON {
				return out.WriteJSON(os.Stdout, map[string]any{
					"pinned":        !unpin,
					"chat":          chatJID.String(),
					"id":            msgID,
					"pin_id":        sentID,
					"duration_secs": secs,
				})
			}
			if unpin {
				fmt.Fprintf(os.Stdout, "Unpinned %s in %s\n", msgID, chatJID.String())
			} else {
				fmt.Fprintf(os.Stdout, "Pinned %s in %s for %s\n", msgID, chatJID.String(), time.Duration(secs)*time.Second)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&chat, "chat", "", "chat JID (e.g. 1203...@g.us)")
	cmd.Flags().StringVar(&msgID, "id", "", "message ID to pin")
	cmd.Flags().StringVar(&sender, "sender", "", "original sender JID when pinning someone else's message (omit for your own)")
	cmd.Flags().StringVar(&durationStr, "duration", "7d", "how long the pin lasts: 24h, 7d or 30d")
	cmd.Flags().BoolVar(&unpin, "unpin", false, "remove the pin instead")
	return cmd
}
